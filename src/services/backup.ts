import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDb } from "../db/client.js";
import { env } from "../config/env.js";

/**
 * SQLite backup/restore (project brief section 59). `VACUUM INTO` produces
 * a consistent, compacted snapshot in one statement — verified live on this
 * machine (a real DatabaseSync, VACUUM INTO, then reopening the output file
 * and reading real rows back). Restore is verified the same way every time
 * it runs, not assumed to have worked — see verifyBackup().
 */

function defaultBackupDir(): string {
  return join(dirname(env.databasePath), "backups");
}

function timestampedBackupPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(defaultBackupDir(), `backup-${stamp}.sqlite`);
}

export interface BackupResult {
  path: string;
  sizeBytes: number;
  tableCounts: Record<string, number>;
}

const CORE_TABLES = ["programs", "tasks", "findings", "approvals", "reports", "earnings", "agent_runs"];

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
  return row.c;
}

/** Creates a consistent backup file and verifies it's actually readable before reporting success. */
export function backupDatabase(destPath?: string): BackupResult {
  const target = destPath ?? timestampedBackupPath();
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) unlinkSync(target); // VACUUM INTO refuses to overwrite an existing file

  const db = getDb();
  const escapedPath = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);

  const verification = verifyBackup(target);
  if (!verification.ok) {
    throw new Error(`Backup written to ${target} but failed verification: ${verification.error}`);
  }

  return { path: target, sizeBytes: statSync(target).size, tableCounts: verification.tableCounts };
}

export interface BackupVerification {
  ok: boolean;
  tableCounts: Record<string, number>;
  error?: string;
}

/** Actually opens the backup file and reads real rows back — never assumes a backup is valid just because the file exists. */
export function verifyBackup(path: string): BackupVerification {
  if (!existsSync(path)) {
    return { ok: false, tableCounts: {}, error: `File does not exist: ${path}` };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    return { ok: false, tableCounts: {}, error: `Could not open as SQLite: ${(err as Error).message}` };
  }

  try {
    const tableCounts: Record<string, number> = {};
    for (const table of CORE_TABLES) {
      tableCounts[table] = countRows(db, table);
    }
    return { ok: true, tableCounts };
  } catch (err) {
    return { ok: false, tableCounts: {}, error: (err as Error).message };
  } finally {
    db.close();
  }
}

export interface RestoreResult {
  restoredTo: string;
  safetyBackupPath: string;
}

/**
 * Restores from a backup file onto the live database path. Always takes a
 * safety backup of whatever is currently live FIRST (so restoring is itself
 * reversible), and verifies the source backup is valid before touching
 * anything.
 */
export function restoreDatabase(sourcePath: string, targetPath: string = env.databasePath): RestoreResult {
  const verification = verifyBackup(sourcePath);
  if (!verification.ok) {
    throw new Error(`Refusing to restore from an unverifiable backup: ${verification.error}`);
  }

  const safetyBackupPath = safetyBackupPathFor(targetPath);
  if (existsSync(targetPath)) {
    mkdirSync(dirname(safetyBackupPath), { recursive: true });
    copyFileSync(targetPath, safetyBackupPath);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);

  // Verify the restored file is actually readable at its new location too —
  // never report success without checking the end state, not just the copy call.
  const postRestoreCheck = verifyBackup(targetPath);
  if (!postRestoreCheck.ok) {
    throw new Error(`Restore completed but the restored file failed verification: ${postRestoreCheck.error}`);
  }

  return { restoredTo: targetPath, safetyBackupPath };
}

function safetyBackupPathFor(targetPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dirname(targetPath), "backups", `pre-restore-${stamp}.sqlite`);
}

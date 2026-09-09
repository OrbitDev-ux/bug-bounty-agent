import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDbForTests, getDb } from "../src/db/client.js";
import { createProgram } from "../src/domain/programs.js";
import { backupDatabase, verifyBackup, restoreDatabase } from "../src/services/backup.js";

// Unlike most tests, backup/restore genuinely needs a real file-backed
// database (VACUUM INTO and file-copy restore don't make sense against
// :memory:), so this file manages its own temp DB file rather than using
// testDb.ts's in-memory freshDb().

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bba-backup-test-"));
  dbPath = join(dir, "live.sqlite");
  resetDbForTests();
  getDb(dbPath);
  createProgram({
    name: "P",
    platform: "self-hosted",
    url: "https://example.com",
    policy: { inScope: ["example.com"], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] },
  });
});

afterEach(() => {
  resetDbForTests();
  rmSync(dir, { recursive: true, force: true });
});

test("backupDatabase produces a file that verifies successfully with real row counts", () => {
  const backupPath = join(dir, "backup.sqlite");
  const result = backupDatabase(backupPath);

  assert.ok(existsSync(result.path));
  assert.ok(result.sizeBytes > 0);
  assert.equal(result.tableCounts.programs, 1);
});

test("verifyBackup reports failure for a nonexistent file, not a false success", () => {
  const result = verifyBackup(join(dir, "does-not-exist.sqlite"));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /does not exist/);
});

test("verifyBackup reports failure for a file that isn't a valid SQLite database", () => {
  const bogusPath = join(dir, "not-a-db.sqlite");
  writeFileSync(bogusPath, "not a database");
  const result = verifyBackup(bogusPath);
  assert.equal(result.ok, false);
});

test("restoreDatabase performs a REAL restore round-trip: backup -> wipe -> restore -> verify data is back", () => {
  const backupPath = join(dir, "backup.sqlite");
  backupDatabase(backupPath);

  // Simulate data loss: create a second program after the backup, so we can
  // tell whether restore actually reverted to the backed-up state.
  createProgram({
    name: "Created After Backup",
    platform: "self-hosted",
    url: "https://after.example",
    policy: { inScope: [], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: false, restrictions: [] },
  });
  const beforeRestore = verifyBackup(dbPath);
  assert.equal(beforeRestore.tableCounts.programs, 2);

  // Restoring requires the live connection to be closed first, same as a
  // real operator would do before overwriting the live file.
  resetDbForTests();
  const restoreResult = restoreDatabase(backupPath, dbPath);

  assert.equal(restoreResult.restoredTo, dbPath);
  assert.ok(existsSync(restoreResult.safetyBackupPath), "a safety backup of the pre-restore state must exist");

  const afterRestore = verifyBackup(dbPath);
  assert.equal(afterRestore.ok, true);
  assert.equal(afterRestore.tableCounts.programs, 1); // back to the pre-second-program state
});

test("restoreDatabase refuses to restore from an unverifiable backup, touching nothing", () => {
  const bogusPath = join(dir, "bogus.sqlite");
  writeFileSync(bogusPath, "garbage");
  assert.throws(() => restoreDatabase(bogusPath, dbPath), /unverifiable/);
});

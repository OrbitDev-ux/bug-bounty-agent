import { randomUUID, createHash } from "node:crypto";
import { getDb } from "../db/client.js";
import type { Program, ProgramPolicy, ProgramStatus } from "./types.js";

interface ProgramRow {
  id: string;
  name: string;
  platform: string;
  url: string;
  policy_json: string;
  status: string;
  policy_last_verified_at: string | null;
  policy_hash: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProgram(row: ProgramRow): Program {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    url: row.url,
    policy: JSON.parse(row.policy_json) as ProgramPolicy,
    status: row.status as ProgramStatus,
    policyLastVerifiedAt: row.policy_last_verified_at,
    policyHash: row.policy_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function hashPolicy(policy: ProgramPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export interface CreateProgramInput {
  name: string;
  platform: string;
  url: string;
  policy: ProgramPolicy;
  status?: ProgramStatus;
  /** Set when the policy was actually read/confirmed just now (the common case for agent-driven onboarding). */
  policyVerifiedNow?: boolean;
}

export function createProgram(input: CreateProgramInput): Program {
  const db = getDb();
  const now = new Date().toISOString();
  const program: Program = {
    id: randomUUID(),
    name: input.name,
    platform: input.platform,
    url: input.url,
    policy: input.policy,
    status: input.status ?? "active",
    policyLastVerifiedAt: input.policyVerifiedNow ? now : null,
    policyHash: hashPolicy(input.policy),
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO programs (id, name, platform, url, policy_json, status, policy_last_verified_at, policy_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    program.id,
    program.name,
    program.platform,
    program.url,
    JSON.stringify(program.policy),
    program.status,
    program.policyLastVerifiedAt ?? null,
    program.policyHash ?? null,
    program.createdAt,
    program.updatedAt,
  );
  return program;
}

export function getProgram(id: string): Program | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM programs WHERE id = ?").get(id) as unknown as ProgramRow | undefined;
  return row ? rowToProgram(row) : null;
}

export function listPrograms(status?: ProgramStatus): Program[] {
  const db = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM programs WHERE status = ? ORDER BY created_at DESC, rowid DESC").all(status) as unknown as ProgramRow[])
    : (db.prepare("SELECT * FROM programs ORDER BY created_at DESC, rowid DESC").all() as unknown as ProgramRow[]);
  return rows.map(rowToProgram);
}

export function updateProgramStatus(id: string, status: ProgramStatus): Program | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE programs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  return getProgram(id);
}

/**
 * Re-verification (project brief section 12): records that the policy was
 * actually re-read just now, updates the hash, and reports whether the
 * policy actually changed since last time (`drifted`) so a caller can flag
 * that for human review rather than silently trusting the new content.
 */
export function reverifyPolicy(id: string, policy: ProgramPolicy): { program: Program; drifted: boolean } {
  const existing = getProgram(id);
  if (!existing) throw new Error(`Program not found: ${id}`);

  const newHash = hashPolicy(policy);
  const drifted = existing.policyHash !== null && existing.policyHash !== newHash;

  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE programs SET policy_json = ?, policy_hash = ?, policy_last_verified_at = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(policy), newHash, now, now, id);

  const updated = getProgram(id);
  if (!updated) throw new Error(`Program disappeared during re-verification: ${id}`);
  return { program: updated, drifted };
}

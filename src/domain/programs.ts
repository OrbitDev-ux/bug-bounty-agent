import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { Program, ProgramPolicy, ProgramStatus } from "./types.js";

interface ProgramRow {
  id: string;
  name: string;
  platform: string;
  url: string;
  policy_json: string;
  status: string;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateProgramInput {
  name: string;
  platform: string;
  url: string;
  policy: ProgramPolicy;
  status?: ProgramStatus;
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
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO programs (id, name, platform, url, policy_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    program.id,
    program.name,
    program.platform,
    program.url,
    JSON.stringify(program.policy),
    program.status,
    program.createdAt,
    program.updatedAt,
  );
  return program;
}

export function getProgram(id: string): Program | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM programs WHERE id = ?").get(id) as ProgramRow | undefined;
  return row ? rowToProgram(row) : null;
}

export function listPrograms(status?: ProgramStatus): Program[] {
  const db = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM programs WHERE status = ? ORDER BY created_at DESC").all(status) as unknown as ProgramRow[])
    : (db.prepare("SELECT * FROM programs ORDER BY created_at DESC").all() as unknown as ProgramRow[]);
  return rows.map(rowToProgram);
}

export function updateProgramStatus(id: string, status: ProgramStatus): Program | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE programs SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  return getProgram(id);
}

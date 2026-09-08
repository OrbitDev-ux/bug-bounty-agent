import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { BountyStatus, Finding, FindingStatus } from "./types.js";

interface FindingRow {
  id: string;
  program_id: string;
  task_id: string | null;
  title: string;
  asset: string;
  summary: string;
  status: string;
  bounty_status: string;
  created_at: string;
  updated_at: string;
}

function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    programId: row.program_id,
    taskId: row.task_id,
    title: row.title,
    asset: row.asset,
    summary: row.summary,
    status: row.status as FindingStatus,
    bountyStatus: row.bounty_status as BountyStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Finding lifecycle (section 10). Any active status can be short-circuited to invalid/closed. */
export const FINDING_TRANSITIONS: Record<FindingStatus, FindingStatus[]> = {
  discovered: ["candidate", "invalid", "closed"],
  candidate: ["validated", "invalid", "closed"],
  validated: ["report_draft", "invalid", "closed"],
  report_draft: ["submitted", "closed"],
  submitted: ["triaged", "closed"],
  triaged: ["accepted", "duplicate", "invalid", "informative", "closed"],
  accepted: ["closed"],
  duplicate: ["closed"],
  invalid: ["closed"],
  informative: ["closed"],
  closed: [],
};

export class InvalidFindingTransitionError extends Error {
  constructor(from: FindingStatus, to: FindingStatus) {
    super(`Invalid finding transition: ${from} -> ${to}`);
    this.name = "InvalidFindingTransitionError";
  }
}

export interface CreateFindingInput {
  programId: string;
  taskId?: string | null;
  title: string;
  asset: string;
  summary?: string;
}

export function createFinding(input: CreateFindingInput): Finding {
  const db = getDb();
  const now = new Date().toISOString();
  const finding: Finding = {
    id: randomUUID(),
    programId: input.programId,
    taskId: input.taskId ?? null,
    title: input.title,
    asset: input.asset,
    summary: input.summary ?? "",
    status: "discovered",
    bountyStatus: "not_applicable",
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO findings (id, program_id, task_id, title, asset, summary, status, bounty_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(finding.id, finding.programId, finding.taskId, finding.title, finding.asset, finding.summary, finding.status, finding.bountyStatus, finding.createdAt, finding.updatedAt);
  return finding;
}

export function getFinding(id: string): Finding | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as FindingRow | undefined;
  return row ? rowToFinding(row) : null;
}

export function listFindings(status?: FindingStatus): Finding[] {
  const db = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM findings WHERE status = ? ORDER BY created_at DESC").all(status) as unknown as FindingRow[])
    : (db.prepare("SELECT * FROM findings ORDER BY created_at DESC").all() as unknown as FindingRow[]);
  return rows.map(rowToFinding);
}

export function transitionFinding(id: string, to: FindingStatus): Finding {
  const finding = getFinding(id);
  if (!finding) throw new Error(`Finding not found: ${id}`);

  const allowed = FINDING_TRANSITIONS[finding.status];
  if (!allowed.includes(to)) {
    throw new InvalidFindingTransitionError(finding.status, to);
  }

  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE findings SET status = ?, updated_at = ? WHERE id = ?").run(to, now, id);

  const updated = getFinding(id);
  if (!updated) throw new Error(`Finding disappeared during transition: ${id}`);
  return updated;
}

export function updateBountyStatus(id: string, bountyStatus: BountyStatus): Finding {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE findings SET bounty_status = ?, updated_at = ? WHERE id = ?").run(bountyStatus, now, id);
  const updated = getFinding(id);
  if (!updated) throw new Error(`Finding not found: ${id}`);
  return updated;
}

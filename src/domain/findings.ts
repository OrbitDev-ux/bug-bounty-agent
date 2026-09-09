import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { BountyStatus, DuplicateVerdict, Finding, FindingStatus, SubmissionMode } from "./types.js";

interface FindingRow {
  id: string;
  program_id: string;
  task_id: string | null;
  title: string;
  asset: string;
  summary: string;
  status: string;
  bounty_status: string;
  category: string | null;
  confidence: number | null;
  confidence_reason: string | null;
  duplicate_verdict: string | null;
  duplicate_of_finding_id: string | null;
  severity_candidate: string | null;
  severity_reason: string | null;
  severity_confidence: number | null;
  research_session_id: string | null;
  submission_mode: string | null;
  submitted_at: string | null;
  accepted_at: string | null;
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
    category: row.category,
    confidence: row.confidence,
    confidenceReason: row.confidence_reason,
    duplicateVerdict: row.duplicate_verdict as DuplicateVerdict | null,
    duplicateOfFindingId: row.duplicate_of_finding_id,
    severityCandidate: row.severity_candidate,
    severityReason: row.severity_reason,
    severityConfidence: row.severity_confidence,
    researchSessionId: row.research_session_id,
    submissionMode: row.submission_mode as SubmissionMode | null,
    submittedAt: row.submitted_at,
    acceptedAt: row.accepted_at,
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
  category?: string | null;
  researchSessionId?: string | null;
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
    category: input.category ?? null,
    confidence: null,
    confidenceReason: null,
    duplicateVerdict: null,
    duplicateOfFindingId: null,
    severityCandidate: null,
    severityReason: null,
    severityConfidence: null,
    researchSessionId: input.researchSessionId ?? null,
    submissionMode: null,
    submittedAt: null,
    acceptedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO findings (id, program_id, task_id, title, asset, summary, status, bounty_status, category, research_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    finding.id,
    finding.programId,
    finding.taskId,
    finding.title,
    finding.asset,
    finding.summary,
    finding.status,
    finding.bountyStatus,
    finding.category,
    finding.researchSessionId,
    finding.createdAt,
    finding.updatedAt,
  );
  return finding;
}

export function getFinding(id: string): Finding | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as unknown as FindingRow | undefined;
  return row ? rowToFinding(row) : null;
}

export function listFindings(status?: FindingStatus): Finding[] {
  const db = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM findings WHERE status = ? ORDER BY created_at DESC").all(status) as unknown as FindingRow[])
    : (db.prepare("SELECT * FROM findings ORDER BY created_at DESC").all() as unknown as FindingRow[]);
  return rows.map(rowToFinding);
}

/** All findings for a program, for duplicate-comparison purposes. */
export function listFindingsForProgram(programId: string): Finding[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM findings WHERE program_id = ? ORDER BY created_at DESC").all(programId) as unknown as FindingRow[];
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
  // Time-to-bounty stamps (section 30): set once, on first arrival, via
  // COALESCE so a later re-transition through the same status (not possible
  // today given the transition table, but kept defensive) never overwrites it.
  db.prepare(
    `UPDATE findings SET
       status = ?,
       submitted_at = COALESCE(submitted_at, ?),
       accepted_at = COALESCE(accepted_at, ?),
       updated_at = ?
     WHERE id = ?`,
  ).run(to, to === "submitted" ? now : null, to === "accepted" ? now : null, now, id);

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

export interface CandidateIntelligenceInput {
  confidence?: number | null;
  confidenceReason?: string | null;
  duplicateVerdict?: DuplicateVerdict | null;
  duplicateOfFindingId?: string | null;
  severityCandidate?: string | null;
  severityReason?: string | null;
  severityConfidence?: number | null;
}

/**
 * Attaches the Research Agent's own confidence/duplicate/severity signals to
 * a candidate finding. None of these are ever treated as ground truth by any
 * other module — they're advisory fields a human reviews alongside the
 * finding, never used to auto-transition status (section 15, 16).
 */
export function setCandidateIntelligence(id: string, input: CandidateIntelligenceInput): Finding {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE findings SET
       confidence = COALESCE(?, confidence),
       confidence_reason = COALESCE(?, confidence_reason),
       duplicate_verdict = COALESCE(?, duplicate_verdict),
       duplicate_of_finding_id = COALESCE(?, duplicate_of_finding_id),
       severity_candidate = COALESCE(?, severity_candidate),
       severity_reason = COALESCE(?, severity_reason),
       severity_confidence = COALESCE(?, severity_confidence),
       updated_at = ?
     WHERE id = ?`,
  ).run(
    input.confidence ?? null,
    input.confidenceReason ?? null,
    input.duplicateVerdict ?? null,
    input.duplicateOfFindingId ?? null,
    input.severityCandidate ?? null,
    input.severityReason ?? null,
    input.severityConfidence ?? null,
    now,
    id,
  );
  const updated = getFinding(id);
  if (!updated) throw new Error(`Finding not found: ${id}`);
  return updated;
}

/** Records a (v0.2: always simulated) submission. See docs/security.md — there is no real platform API integration. */
export function markSubmissionMode(id: string, mode: SubmissionMode): Finding {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE findings SET submission_mode = ?, updated_at = ? WHERE id = ?").run(mode, now, id);
  const updated = getFinding(id);
  if (!updated) throw new Error(`Finding not found: ${id}`);
  return updated;
}

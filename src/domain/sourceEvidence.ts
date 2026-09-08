import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { SourceEvidence, SourceType } from "./types.js";

interface SourceEvidenceRow {
  id: string;
  research_session_id: string | null;
  finding_id: string | null;
  source_url: string;
  source_type: string;
  title: string;
  relevant_excerpt: string;
  captured_at: string;
}

function rowToEvidence(row: SourceEvidenceRow): SourceEvidence {
  return {
    id: row.id,
    researchSessionId: row.research_session_id,
    findingId: row.finding_id,
    sourceUrl: row.source_url,
    sourceType: row.source_type as SourceType,
    title: row.title,
    relevantExcerpt: row.relevant_excerpt,
    capturedAt: row.captured_at,
  };
}

export interface RecordSourceEvidenceInput {
  researchSessionId?: string | null;
  findingId?: string | null;
  sourceUrl: string;
  sourceType: SourceType;
  title?: string;
  relevantExcerpt?: string;
}

/**
 * Every research claim traces back to one of these (project brief section
 * 9). `relevantExcerpt` is a quoted excerpt from the source page — it is
 * stored and displayed as data, and must never be treated as an instruction
 * to the agent (see docs/security.md's prompt-injection defense section).
 */
export function recordSourceEvidence(input: RecordSourceEvidenceInput): SourceEvidence {
  const db = getDb();
  const evidence: SourceEvidence = {
    id: randomUUID(),
    researchSessionId: input.researchSessionId ?? null,
    findingId: input.findingId ?? null,
    sourceUrl: input.sourceUrl,
    sourceType: input.sourceType,
    title: input.title ?? "",
    relevantExcerpt: input.relevantExcerpt ?? "",
    capturedAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO source_evidence (id, research_session_id, finding_id, source_url, source_type, title, relevant_excerpt, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evidence.id,
    evidence.researchSessionId,
    evidence.findingId,
    evidence.sourceUrl,
    evidence.sourceType,
    evidence.title,
    evidence.relevantExcerpt,
    evidence.capturedAt,
  );
  return evidence;
}

export function listEvidenceForSession(researchSessionId: string): SourceEvidence[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM source_evidence WHERE research_session_id = ? ORDER BY captured_at ASC")
    .all(researchSessionId) as unknown as SourceEvidenceRow[];
  return rows.map(rowToEvidence);
}

export function listEvidenceForFinding(findingId: string): SourceEvidence[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM source_evidence WHERE finding_id = ? ORDER BY captured_at ASC").all(findingId) as unknown as SourceEvidenceRow[];
  return rows.map(rowToEvidence);
}

/** Attaches existing evidence rows (e.g. from the research session) to a newly-approved candidate finding. */
export function linkEvidenceToFinding(evidenceId: string, findingId: string): void {
  const db = getDb();
  db.prepare("UPDATE source_evidence SET finding_id = ? WHERE id = ?").run(findingId, evidenceId);
}

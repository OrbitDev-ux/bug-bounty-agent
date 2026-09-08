import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { PageVisited, ResearchSession, ResearchSessionStatus } from "./types.js";

interface ResearchSessionRow {
  id: string;
  program_id: string | null;
  task_id: string | null;
  goal: string;
  status: string;
  queries_json: string;
  pages_visited_json: string;
  scope_observations: string;
  policy_observations: string;
  summary: string;
  next_recommended_action: string;
  confidence: number | null;
  candidate_finding_ids_json: string;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: ResearchSessionRow): ResearchSession {
  return {
    id: row.id,
    programId: row.program_id,
    taskId: row.task_id,
    goal: row.goal,
    status: row.status as ResearchSessionStatus,
    queries: JSON.parse(row.queries_json) as string[],
    pagesVisited: JSON.parse(row.pages_visited_json) as PageVisited[],
    scopeObservations: row.scope_observations,
    policyObservations: row.policy_observations,
    summary: row.summary,
    nextRecommendedAction: row.next_recommended_action,
    confidence: row.confidence,
    candidateFindingIds: JSON.parse(row.candidate_finding_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface StartResearchSessionInput {
  programId?: string | null;
  taskId?: string | null;
  goal: string;
}

/**
 * Starts a resumable research session (project brief section 8): status
 * stays 'running' until explicitly completed/failed, and every field is
 * append/update-able mid-flight, so a crashed process can be picked back up
 * against the same session id rather than losing partial research.
 */
export function startResearchSession(input: StartResearchSessionInput): ResearchSession {
  const db = getDb();
  const now = new Date().toISOString();
  const session: ResearchSession = {
    id: randomUUID(),
    programId: input.programId ?? null,
    taskId: input.taskId ?? null,
    goal: input.goal,
    status: "running",
    queries: [],
    pagesVisited: [],
    scopeObservations: "",
    policyObservations: "",
    summary: "",
    nextRecommendedAction: "",
    confidence: null,
    candidateFindingIds: [],
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO research_sessions (id, program_id, task_id, goal, status, queries_json, pages_visited_json, scope_observations, policy_observations, summary, next_recommended_action, confidence, candidate_finding_ids_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.programId,
    session.taskId,
    session.goal,
    session.status,
    JSON.stringify(session.queries),
    JSON.stringify(session.pagesVisited),
    session.scopeObservations,
    session.policyObservations,
    session.summary,
    session.nextRecommendedAction,
    session.confidence,
    JSON.stringify(session.candidateFindingIds),
    session.createdAt,
    session.updatedAt,
  );
  return session;
}

export function getResearchSession(id: string): ResearchSession | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM research_sessions WHERE id = ?").get(id) as unknown as ResearchSessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function listResearchSessions(status?: ResearchSessionStatus): ResearchSession[] {
  const db = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM research_sessions WHERE status = ? ORDER BY created_at DESC").all(status) as unknown as ResearchSessionRow[])
    : (db.prepare("SELECT * FROM research_sessions ORDER BY created_at DESC").all() as unknown as ResearchSessionRow[]);
  return rows.map(rowToSession);
}

/** Resumable sessions a worker can pick back up (crash recovery for research, not just tasks). */
export function listRunningResearchSessions(): ResearchSession[] {
  return listResearchSessions("running");
}

export function addQuery(id: string, query: string): ResearchSession {
  const session = mustGet(id);
  return patch(id, { queries_json: JSON.stringify([...session.queries, query]) });
}

export function addPageVisited(id: string, page: PageVisited): ResearchSession {
  const session = mustGet(id);
  return patch(id, { pages_visited_json: JSON.stringify([...session.pagesVisited, page]) });
}

export interface CompleteResearchSessionInput {
  status: Exclude<ResearchSessionStatus, "running">;
  scopeObservations?: string;
  policyObservations?: string;
  summary?: string;
  nextRecommendedAction?: string;
  confidence?: number | null;
  candidateFindingIds?: string[];
}

export function completeResearchSession(id: string, input: CompleteResearchSessionInput): ResearchSession {
  mustGet(id);
  return patch(id, {
    status: input.status,
    scope_observations: input.scopeObservations,
    policy_observations: input.policyObservations,
    summary: input.summary,
    next_recommended_action: input.nextRecommendedAction,
    confidence: input.confidence,
    candidate_finding_ids_json: input.candidateFindingIds ? JSON.stringify(input.candidateFindingIds) : undefined,
  });
}

function mustGet(id: string): ResearchSession {
  const s = getResearchSession(id);
  if (!s) throw new Error(`Research session not found: ${id}`);
  return s;
}

// Small internal helper: builds a COALESCE-free partial UPDATE from only the
// keys actually provided, since research sessions are updated incrementally
// from many different call sites (queries, pages, final summary).
function patch(id: string, fields: Record<string, unknown>): ResearchSession {
  const db = getDb();
  const now = new Date().toISOString();
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  const setClause = entries.map(([k]) => `${k} = ?`).join(", ");
  const values = entries.map(([, v]) => v) as (string | number | null)[];
  db.prepare(`UPDATE research_sessions SET ${setClause}, updated_at = ? WHERE id = ?`).run(...values, now, id);
  return mustGet(id);
}

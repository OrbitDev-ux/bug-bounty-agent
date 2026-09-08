import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { AgentRun, AgentRunKind, AgentRunStatus } from "./types.js";

interface AgentRunRow {
  id: string;
  kind: string;
  status: string;
  task_id: string | null;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
}

function rowToRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    kind: row.kind as AgentRunKind,
    status: row.status as AgentRunStatus,
    taskId: row.task_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
  };
}

export function startRun(kind: AgentRunKind, taskId: string | null = null): AgentRun {
  const db = getDb();
  const run: AgentRun = {
    id: randomUUID(),
    kind,
    status: "running",
    taskId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    summary: null,
  };
  db.prepare(`INSERT INTO agent_runs (id, kind, status, task_id, started_at, finished_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    run.id,
    run.kind,
    run.status,
    run.taskId,
    run.startedAt,
    run.finishedAt,
    run.summary,
  );
  return run;
}

export function finishRun(id: string, status: Exclude<AgentRunStatus, "running">, summary?: string): AgentRun | null {
  const db = getDb();
  db.prepare("UPDATE agent_runs SET status = ?, finished_at = ?, summary = COALESCE(?, summary) WHERE id = ?").run(
    status,
    new Date().toISOString(),
    summary ?? null,
    id,
  );
  return getRun(id);
}

export function getRun(id: string): AgentRun | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as unknown as AgentRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listRuns(): AgentRun[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC").all() as unknown as AgentRunRow[];
  return rows.map(rowToRun);
}

export function listRunningRuns(): AgentRun[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM agent_runs WHERE status = 'running' ORDER BY started_at DESC").all() as unknown as AgentRunRow[];
  return rows.map(rowToRun);
}

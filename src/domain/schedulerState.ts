import { getDb } from "../db/client.js";
import type { SchedulerRunLimits, SchedulerState, SchedulerStatus } from "./types.js";

const SINGLETON_ID = "singleton";

interface SchedulerStateRow {
  id: string;
  status: string;
  current_task_id: string | null;
  max_tasks_per_run: number | null;
  max_runtime_ms: number | null;
  max_browser_ops: number | null;
  max_retries: number | null;
  tasks_run_this_run: number;
  browser_ops_this_run: number;
  started_at: string | null;
  updated_at: string;
}

function rowToState(row: SchedulerStateRow): SchedulerState {
  return {
    status: row.status as SchedulerStatus,
    currentTaskId: row.current_task_id,
    maxTasksPerRun: row.max_tasks_per_run,
    maxRuntimeMs: row.max_runtime_ms,
    maxBrowserOps: row.max_browser_ops,
    maxRetries: row.max_retries,
    tasksRunThisRun: row.tasks_run_this_run,
    browserOpsThisRun: row.browser_ops_this_run,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

/** Ensures the singleton row exists, and returns the current state. */
export function getSchedulerState(): SchedulerState {
  const db = getDb();
  let row = db.prepare("SELECT * FROM scheduler_state WHERE id = ?").get(SINGLETON_ID) as unknown as SchedulerStateRow | undefined;
  if (!row) {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO scheduler_state (id, status, updated_at) VALUES (?, 'stopped', ?)").run(SINGLETON_ID, now);
    row = db.prepare("SELECT * FROM scheduler_state WHERE id = ?").get(SINGLETON_ID) as unknown as SchedulerStateRow;
  }
  return rowToState(row);
}

export type StartSchedulerInput = Partial<SchedulerRunLimits>;

/** RUNNING (project brief section 30/33): resets per-run counters and applies this run's limits. */
export function startScheduler(input: StartSchedulerInput = {}): SchedulerState {
  getSchedulerState(); // ensure row exists
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE scheduler_state SET
       status = 'running',
       current_task_id = NULL,
       max_tasks_per_run = ?,
       max_runtime_ms = ?,
       max_browser_ops = ?,
       max_retries = ?,
       tasks_run_this_run = 0,
       browser_ops_this_run = 0,
       started_at = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    input.maxTasksPerRun ?? null,
    input.maxRuntimeMs ?? null,
    input.maxBrowserOps ?? null,
    input.maxRetries ?? null,
    now,
    now,
    SINGLETON_ID,
  );
  return getSchedulerState();
}

export function stopScheduler(): SchedulerState {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE scheduler_state SET status = 'stopped', current_task_id = NULL, updated_at = ? WHERE id = ?").run(now, SINGLETON_ID);
  return getSchedulerState();
}

/** PAUSED (section 34): blocks new task execution but preserves all state (queue, in-flight approvals) untouched. */
export function pauseScheduler(): SchedulerState {
  const state = getSchedulerState();
  if (state.status !== "running") {
    throw new Error(`Cannot pause: scheduler is '${state.status}', not 'running'.`);
  }
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE scheduler_state SET status = 'paused', updated_at = ? WHERE id = ?").run(now, SINGLETON_ID);
  return getSchedulerState();
}

export function resumeScheduler(): SchedulerState {
  const state = getSchedulerState();
  if (state.status !== "paused") {
    throw new Error(`Cannot resume: scheduler is '${state.status}', not 'paused'.`);
  }
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE scheduler_state SET status = 'running', updated_at = ? WHERE id = ?").run(now, SINGLETON_ID);
  return getSchedulerState();
}

export function setCurrentTask(taskId: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE scheduler_state SET current_task_id = ?, updated_at = ? WHERE id = ?").run(taskId, now, SINGLETON_ID);
}

export function incrementTasksRun(): SchedulerState {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE scheduler_state SET tasks_run_this_run = tasks_run_this_run + 1, updated_at = ? WHERE id = ?").run(now, SINGLETON_ID);
  return getSchedulerState();
}

export function incrementBrowserOps(by = 1): SchedulerState {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE scheduler_state SET browser_ops_this_run = browser_ops_this_run + ?, updated_at = ? WHERE id = ?").run(by, now, SINGLETON_ID);
  return getSchedulerState();
}

/** Run-limit checks (section 33). Any true result means the worker loop must stop this run. */
export function runLimitReached(state: SchedulerState, now: Date = new Date()): { reached: boolean; reason: string | null } {
  if (state.maxTasksPerRun !== null && state.tasksRunThisRun >= state.maxTasksPerRun) {
    return { reached: true, reason: `max_tasks_per_run (${state.maxTasksPerRun}) reached` };
  }
  if (state.maxBrowserOps !== null && state.browserOpsThisRun >= state.maxBrowserOps) {
    return { reached: true, reason: `max_browser_ops (${state.maxBrowserOps}) reached` };
  }
  if (state.maxRuntimeMs !== null && state.startedAt !== null) {
    const elapsed = now.getTime() - new Date(state.startedAt).getTime();
    if (elapsed >= state.maxRuntimeMs) {
      return { reached: true, reason: `max_runtime_ms (${state.maxRuntimeMs}) reached (elapsed ${elapsed}ms)` };
    }
  }
  return { reached: false, reason: null };
}

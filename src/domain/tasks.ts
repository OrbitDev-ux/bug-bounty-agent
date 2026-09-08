import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { Task, TaskPriority, TaskStatus, TaskType } from "./types.js";

interface TaskRow {
  id: string;
  type: string;
  program_id: string | null;
  target: string;
  status: string;
  priority: string;
  result: string | null;
  failure_reason: string | null;
  retry_count: number;
  timeout_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type as TaskType,
    programId: row.program_id,
    target: row.target,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    result: row.result,
    failureReason: row.failure_reason,
    retryCount: row.retry_count,
    timeoutAt: row.timeout_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Legal task state transitions (section 9 of the project brief).
 * Enforced centrally so no caller can silently skip e.g. approval.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "blocked", "failed"],
  running: ["waiting_approval", "completed", "failed", "blocked"],
  waiting_approval: ["approved", "rejected"],
  approved: ["running", "completed"],
  rejected: [],
  completed: [],
  failed: ["queued"], // explicit retry only
  blocked: ["queued", "failed"],
};

export class InvalidTaskTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}

export interface CreateTaskInput {
  type: TaskType;
  /** Omit for program-less discovery tasks (public search before any Program exists). */
  programId?: string | null;
  target: string;
  priority?: TaskPriority;
}

export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    type: input.type,
    programId: input.programId ?? null,
    target: input.target,
    status: "queued",
    priority: input.priority ?? "normal",
    result: null,
    failureReason: null,
    retryCount: 0,
    timeoutAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO tasks (id, type, program_id, target, status, priority, result, failure_reason, retry_count, timeout_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.type,
    task.programId,
    task.target,
    task.status,
    task.priority,
    task.result,
    task.failureReason,
    task.retryCount,
    task.timeoutAt,
    task.createdAt,
    task.updatedAt,
  );
  return task;
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(status?: TaskStatus): Task[] {
  const db = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC").all(status) as unknown as TaskRow[])
    : (db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as unknown as TaskRow[]);
  return rows.map(rowToTask);
}

/** Tasks currently 'running' whose timeout_at has passed — candidates for crash recovery. */
export function listStaleRunningTasks(now: Date = new Date()): Task[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM tasks WHERE status = 'running' AND timeout_at IS NOT NULL AND timeout_at < ? ORDER BY timeout_at ASC")
    .all(now.toISOString()) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

export interface TransitionOptions {
  result?: string;
  failureReason?: string;
  /** Only meaningful when transitioning into 'running': sets the crash-recovery deadline. */
  timeoutAt?: string | null;
}

export function transitionTask(id: string, to: TaskStatus, opts: TransitionOptions = {}): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);

  const allowed = TASK_TRANSITIONS[task.status];
  if (!allowed.includes(to)) {
    throw new InvalidTaskTransitionError(task.status, to);
  }

  const db = getDb();
  const now = new Date().toISOString();
  // Leaving 'running' clears any pending timeout; entering 'running' may set a new one.
  const nextTimeoutAt = to === "running" ? (opts.timeoutAt ?? null) : null;
  db.prepare(
    `UPDATE tasks SET status = ?, result = COALESCE(?, result), failure_reason = COALESCE(?, failure_reason), timeout_at = ?, updated_at = ? WHERE id = ?`,
  ).run(to, opts.result ?? null, opts.failureReason ?? null, nextTimeoutAt, now, id);

  const updated = getTask(id);
  if (!updated) throw new Error(`Task disappeared during transition: ${id}`);
  return updated;
}

/** Cancels a task from whatever cancellable state it's in (CLI `task cancel`). */
export function cancelTask(id: string, reason: string): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);

  if (task.status === "waiting_approval") {
    return transitionTask(id, "rejected", { failureReason: reason });
  }
  if (task.status === "queued" || task.status === "running" || task.status === "blocked") {
    return transitionTask(id, "failed", { failureReason: reason });
  }
  throw new InvalidTaskTransitionError(task.status, "failed");
}

/**
 * Crash recovery (project brief section 32): a task stuck in 'running' past
 * its timeout never silently "succeeds" — it always moves to 'failed' with
 * an explicit stale-timeout reason first (RUNNING -> stale timeout ->
 * RECOVER). The caller (scheduler) decides separately whether to requeue it
 * (queued) or leave it for human review, based on retry_count vs. its own
 * max-retries limit — see `requeueRecoveredTask`.
 */
export function recoverStaleTask(id: string): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status !== "running") {
    throw new Error(`Task ${id} is not 'running' (currently ${task.status}); nothing to recover.`);
  }

  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = 'failed', failure_reason = ?, retry_count = retry_count + 1, timeout_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(`Recovered: task exceeded its timeout while 'running' (possible crash). Was due by ${task.timeoutAt}.`, now, id);

  const updated = getTask(id);
  if (!updated) throw new Error(`Task disappeared during recovery: ${id}`);
  return updated;
}

/** Requeues a recovered (failed) task iff it hasn't exceeded maxRetries; otherwise leaves it 'failed' for human review. */
export function requeueRecoveredTask(id: string, maxRetries: number): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status !== "failed") {
    throw new Error(`Task ${id} is not 'failed' (currently ${task.status}).`);
  }
  if (task.retryCount > maxRetries) {
    return task; // leave as 'failed' — needs human review, not auto-requeued
  }
  return transitionTask(id, "queued");
}

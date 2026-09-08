import { listTasks, listStaleRunningTasks } from "../domain/tasks.js";
import { expireStaleApprovals } from "../domain/approvals.js";
import type { Task, TaskPriority } from "../domain/types.js";

/**
 * Research Planner (project brief section 24-25). Deliberately simple for
 * v0.2's scale: task.priority (already part of the schema) plus FIFO within
 * a priority band IS the prioritization policy — this is not a scoring
 * model. P0 safety housekeeping (stale-task recovery, approval expiry) is
 * handled separately by the scheduler on every loop tick, before the
 * Planner is even asked for a task, so it always runs regardless of queue
 * state.
 */

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

export interface PlannerDecision {
  nextTask: Task | null;
  reason: string;
  priority: TaskPriority | null;
  risk: "low" | "needs_review";
}

export function selectNextTask(): PlannerDecision {
  const queued = listTasks("queued");
  if (queued.length === 0) {
    return { nextTask: null, reason: "Queue is empty.", priority: null, risk: "low" };
  }

  const sorted = [...queued].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
  const next = sorted[0]!;

  return {
    nextTask: next,
    reason: `Highest-priority queued task (${next.priority}), oldest first — ${queued.length} task(s) in queue.`,
    priority: next.priority,
    // research/scope_check tasks are read-only-until-approval; anything else (validate/submit) is flagged
    // for review rather than assumed safe, since v0.2 has no automated executor for those types.
    risk: next.type === "research" || next.type === "scope_check" || next.type === "report_draft" ? "low" : "needs_review",
  };
}

export interface HousekeepingResult {
  recoveredTaskIds: string[];
  expiredApprovalCount: number;
}

/** P0 safety pass (section 25/32): always runs before the Planner picks new work. */
export function runSafetyHousekeeping(recoverFn: (taskId: string) => void, now: Date = new Date()): HousekeepingResult {
  const stale = listStaleRunningTasks(now);
  for (const t of stale) recoverFn(t.id);
  const expiredApprovalCount = expireStaleApprovals(now);
  return { recoveredTaskIds: stale.map((t) => t.id), expiredApprovalCount };
}

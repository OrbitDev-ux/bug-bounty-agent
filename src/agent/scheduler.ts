import {
  getSchedulerState,
  startScheduler,
  stopScheduler,
  pauseScheduler,
  resumeScheduler,
  setCurrentTask,
  incrementTasksRun,
  incrementBrowserOps,
  runLimitReached,
} from "../domain/schedulerState.js";
import { recoverStaleTask, requeueRecoveredTask, transitionTask } from "../domain/tasks.js";
import type { Task } from "../domain/types.js";
import { selectNextTask, runSafetyHousekeeping } from "./planner.js";
import { executeDiscoveryTask, executeResearchTask } from "./orchestrator.js";
import { log } from "../logging/logger.js";
import { startRun, finishRun } from "../domain/agentRuns.js";

/** Applied when the caller doesn't specify a limit — v0.2 never runs truly unbounded (section 33). */
const DEFAULT_LIMITS = {
  maxTasksPerRun: 20,
  maxRuntimeMs: 2 * 60 * 60 * 1000, // 2 hours
  maxBrowserOps: 200,
  maxRetries: 3,
};

export interface SchedulerLimitsInput {
  maxTasksPerRun?: number | null;
  maxRuntimeMs?: number | null;
  maxBrowserOps?: number | null;
  maxRetries?: number | null;
}

function resolveLimits(input: SchedulerLimitsInput = {}) {
  return {
    maxTasksPerRun: input.maxTasksPerRun ?? DEFAULT_LIMITS.maxTasksPerRun,
    maxRuntimeMs: input.maxRuntimeMs ?? DEFAULT_LIMITS.maxRuntimeMs,
    maxBrowserOps: input.maxBrowserOps ?? DEFAULT_LIMITS.maxBrowserOps,
    maxRetries: input.maxRetries ?? DEFAULT_LIMITS.maxRetries,
  };
}

/** Crash recovery pass (section 32), exposed standalone so the CLI/tests can run it without a full loop. */
export function recoverStaleTasksNow(maxRetries?: number): { recoveredTaskIds: string[]; requeuedTaskIds: string[]; expiredApprovalCount: number } {
  const limits = resolveLimits({ maxRetries });
  const requeuedTaskIds: string[] = [];
  const housekeeping = runSafetyHousekeeping((taskId) => {
    const recovered = recoverStaleTask(taskId);
    log("task_recovered", { taskId, retryCount: recovered.retryCount });
    const requeued = requeueRecoveredTask(taskId, limits.maxRetries);
    if (requeued.status === "queued") requeuedTaskIds.push(taskId);
  });
  return { recoveredTaskIds: housekeeping.recoveredTaskIds, requeuedTaskIds, expiredApprovalCount: housekeeping.expiredApprovalCount };
}

async function dispatchTask(task: Task): Promise<{ ok: boolean; note: string }> {
  if (task.type === "research") {
    incrementBrowserOps(1); // approximate: one research task ~= one Safari browsing pass
    if (task.programId) {
      const result = await executeResearchTask(task);
      return { ok: result.ok, note: result.ok ? `research completed, ${result.findingsCreated.length} candidate(s)` : (result.error ?? "research failed") };
    }
    const result = await executeDiscoveryTask(task);
    return { ok: task.status !== "failed", note: result.summary ? "discovery completed" : "discovery failed" };
  }

  // v0.2 has no automated executor for scope_check/validate/submit as standalone queued
  // tasks — those flows run inline via the orchestrator's onboarding/approval-driven
  // functions instead. Blocking here (rather than leaving 'queued' forever) keeps the
  // queue from spinning on work the scheduler can't actually do.
  transitionTask(task.id, "blocked", { failureReason: `No scheduler handler for task type '${task.type}' in v0.2.` });
  return { ok: false, note: `no handler for task type '${task.type}'` };
}

export interface WorkerLoopSummary {
  tasksExecuted: number;
  stoppedReason: string;
}

/**
 * The Scheduler -> Queue -> Worker -> Planner -> Task -> Research -> Approval
 * -> Result -> Next Task loop (section 31). Bounded by run limits (never
 * unbounded — section 33); re-checks scheduler_state every iteration so an
 * external `agent pause`/`agent stop` (a separate CLI invocation) takes
 * effect before the next task starts, not just at loop entry.
 */
export async function runWorkerLoop(limitsInput: SchedulerLimitsInput = {}): Promise<WorkerLoopSummary> {
  const limits = resolveLimits(limitsInput);
  startScheduler(limits);
  const agentRun = startRun("scheduled");
  log("scheduler_started", { runId: agentRun.id, limits });

  let tasksExecuted = 0;
  let stoppedReason = "unknown";

  try {
    for (;;) {
      const state = getSchedulerState();
      if (state.status === "paused") {
        stoppedReason = "paused";
        break;
      }
      if (state.status === "stopped") {
        stoppedReason = "stopped externally";
        break;
      }

      const limitCheck = runLimitReached(state);
      if (limitCheck.reached) {
        stoppedReason = limitCheck.reason ?? "run limit reached";
        break;
      }

      recoverStaleTasksNow(limits.maxRetries);

      const decision = selectNextTask();
      if (!decision.nextTask) {
        stoppedReason = "queue empty";
        break;
      }

      setCurrentTask(decision.nextTask.id);
      log("task_started", { taskId: decision.nextTask.id, plannerReason: decision.reason, risk: decision.risk });

      try {
        const outcome = await dispatchTask(decision.nextTask);
        log("task_completed", { taskId: decision.nextTask.id, ok: outcome.ok, note: outcome.note });
      } catch (err) {
        log("task_failed", { taskId: decision.nextTask.id, error: (err as Error).message });
      }

      incrementTasksRun();
      tasksExecuted++;
      setCurrentTask(null);
    }
  } finally {
    setCurrentTask(null);
    const finalState = getSchedulerState();
    if (finalState.status === "running") {
      stopScheduler();
    }
    finishRun(agentRun.id, "completed", `${tasksExecuted} task(s) executed; stopped: ${stoppedReason}`);
    log("scheduler_stopped", { runId: agentRun.id, tasksExecuted, stoppedReason });
  }

  return { tasksExecuted, stoppedReason };
}

/** Runs exactly one task (or reports there's nothing to do) — for `agent run-once`. */
export async function runOnce(): Promise<{ ranTask: boolean; taskId?: string; outcome?: string }> {
  recoverStaleTasksNow();
  const decision = selectNextTask();
  if (!decision.nextTask) return { ranTask: false };

  const taskId = decision.nextTask.id;
  setCurrentTask(taskId);
  try {
    const outcome = await dispatchTask(decision.nextTask);
    log("task_completed", { taskId, ok: outcome.ok, note: outcome.note });
    return { ranTask: true, taskId, outcome: outcome.note };
  } finally {
    setCurrentTask(null);
  }
}

export function pauseAgent() {
  const state = pauseScheduler();
  log("scheduler_paused", { currentTaskId: state.currentTaskId });
  return state;
}

export function resumeAgent() {
  const state = resumeScheduler();
  log("scheduler_resumed", {});
  return state;
}

export function stopAgent() {
  const state = stopScheduler();
  log("scheduler_stopped", { note: "stopped via CLI, not from within the worker loop" });
  return state;
}

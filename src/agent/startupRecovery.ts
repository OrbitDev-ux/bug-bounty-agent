import { recoverStaleTasksNow } from "./scheduler.js";
import { recoverStaleResearchSessions } from "../domain/researchSessions.js";
import { getSchedulerState, stopScheduler } from "../domain/schedulerState.js";
import { log } from "../logging/logger.js";

export interface StartupRecoveryReport {
  recoveredTaskIds: string[];
  requeuedTaskIds: string[];
  recoveredResearchSessionIds: string[];
  expiredApprovalCount: number;
  schedulerStateReset: boolean;
}

/**
 * Startup recovery (project brief section 29): every time the process
 * starts (daemon boot, `agent start`, or a fresh CLI invocation), check
 * everything that could have been left mid-flight by a previous crash —
 * SQLite is opened by whoever calls this first, so no separate step is
 * needed for that. Nothing here ever assumes success; anything
 * unrecoverable is left in a `failed`/`expired` state with an explicit
 * note for a human to review, never silently marked done.
 */
export function runStartupRecovery(): StartupRecoveryReport {
  // recoverStaleTasksNow()'s safety-housekeeping pass already sweeps expired
  // approvals (see planner.ts's runSafetyHousekeeping) — reuse its count
  // rather than sweeping twice.
  const taskRecovery = recoverStaleTasksNow();
  const recoveredResearchSessionIds = recoverStaleResearchSessions();
  const expiredApprovalCount = taskRecovery.expiredApprovalCount;

  // A scheduler_state row claiming 'running' at fresh process startup is
  // definitionally stale — the process that set it is gone. Reset to
  // 'stopped' (not 'paused', since nothing is actually preserved to resume
  // — the in-memory loop is gone) so a human/daemon explicitly restarts it.
  const state = getSchedulerState();
  const schedulerStateReset = state.status === "running";
  if (schedulerStateReset) {
    stopScheduler();
  }

  const report: StartupRecoveryReport = {
    recoveredTaskIds: taskRecovery.recoveredTaskIds,
    requeuedTaskIds: taskRecovery.requeuedTaskIds,
    recoveredResearchSessionIds,
    expiredApprovalCount,
    schedulerStateReset,
  };

  log("startup_recovery", { ...report });
  return report;
}

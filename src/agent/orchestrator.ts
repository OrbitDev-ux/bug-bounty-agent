import { createTask, transitionTask, getTask } from "../domain/tasks.js";
import { createProgram } from "../domain/programs.js";
import { checkTargetInScope } from "./scopeChecker.js";
import { researchCandidatePrograms, extractProgramPolicy } from "./researcher.js";
import { requestApproval } from "../telegram/bot.js";
import { log } from "../logging/logger.js";
import type { Program, Task } from "../domain/types.js";

/**
 * Orchestrator: the thin Scheduler/Planner glue between roles (Researcher,
 * Scope Checker, Approval Manager). It does not itself decide policy — every
 * scope-sensitive step still goes through scopeChecker, and every
 * external-impacting step still goes through Telegram approval, per section 13.
 */

export interface DiscoveryRunResult {
  task: Task;
  summary: string;
  costUsd: number;
}

/** Public research task: no program, no approval needed (section 13). */
export async function runDiscovery(topic: string): Promise<DiscoveryRunResult> {
  const task = createTask({ type: "research", target: topic });
  log("task_created", { taskId: task.id, type: task.type, target: task.target });

  transitionTask(task.id, "running");
  log("task_started", { taskId: task.id });

  const result = await researchCandidatePrograms(topic);

  if (!result.ok) {
    transitionTask(task.id, "failed", { failureReason: result.error ?? "Unknown research failure" });
    log("task_failed", { taskId: task.id, reason: result.error });
    return { task: getTask(task.id)!, summary: "", costUsd: result.costUsd };
  }

  const completed = transitionTask(task.id, "completed", { result: result.summary });
  log("task_completed", { taskId: task.id, costUsd: result.costUsd });
  return { task: completed, summary: result.summary, costUsd: result.costUsd };
}

export interface OnboardResult {
  ok: boolean;
  program: Program | null;
  task: Task | null;
  approvalRequested: boolean;
  reason: string;
  costUsd: number;
}

/**
 * Reads a program's public policy page, records the program with whatever
 * scope it actually publishes, then runs the mandatory scope check against
 * the program's own primary domain and — if in scope — requests Telegram
 * approval before the task is considered actionable. Mirrors the section 27
 * end-to-end flow: search -> read -> extract scope -> create program ->
 * create task -> Telegram approval.
 */
export async function onboardProgramFromPolicyPage(input: {
  name: string;
  platform: string;
  policyUrl: string;
}): Promise<OnboardResult> {
  const extraction = await extractProgramPolicy(input.policyUrl);
  if (!extraction.ok || !extraction.policy) {
    return { ok: false, program: null, task: null, approvalRequested: false, reason: extraction.error ?? "Extraction failed", costUsd: extraction.costUsd };
  }

  const program = createProgram({
    name: input.name,
    platform: input.platform,
    url: input.policyUrl,
    policy: extraction.policy,
    status: extraction.policy.automationAllowed ? "active" : "paused",
  });
  log("finding_created", { note: "program_created", programId: program.id, status: program.status });

  // Prefer the program's own published in-scope domain over the policy page's
  // own host — the policy/info page itself is frequently NOT an in-scope asset.
  const firstInScope = extraction.policy.inScope[0]?.replace(/^\*\./, "");
  const primaryTarget = firstInScope || new URL(input.policyUrl).hostname;
  const task = createTask({ type: "scope_check", programId: program.id, target: primaryTarget });
  log("task_created", { taskId: task.id, type: task.type, programId: program.id, target: primaryTarget });

  transitionTask(task.id, "running");
  log("task_started", { taskId: task.id });

  const decision = checkTargetInScope(program.id, primaryTarget);

  if (!decision.allowed) {
    transitionTask(task.id, "blocked", { failureReason: decision.reason });
    log("task_failed", { taskId: task.id, reason: decision.reason });
    return { ok: true, program, task: getTask(task.id), approvalRequested: false, reason: decision.reason, costUsd: extraction.costUsd };
  }

  transitionTask(task.id, "waiting_approval");

  const { delivered, deliveryError } = await requestApproval({
    taskId: task.id,
    requestedAction: `Confirm program "${program.name}" (${primaryTarget}) and continue research task ${task.id}.`,
    context: {
      programName: program.name,
      asset: primaryTarget,
      actionDescription: "Continue validation",
    },
  });

  const reason = delivered ? decision.reason : `${decision.reason} (Telegram delivery skipped: ${deliveryError})`;
  return { ok: true, program, task: getTask(task.id), approvalRequested: delivered, reason, costUsd: extraction.costUsd };
}

/** Completes a task that has just been approved (waiting_approval -> approved -> completed). */
export function finalizeApprovedTask(taskId: string, resultSummary: string): Task {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== "approved") {
    throw new Error(`Task ${taskId} is not in 'approved' state (currently ${task.status}); cannot finalize.`);
  }
  const completed = transitionTask(taskId, "completed", { result: resultSummary });
  log("task_completed", { taskId, note: "finalized_after_approval" });
  return completed;
}

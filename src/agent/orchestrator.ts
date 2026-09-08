import { createTask, transitionTask, getTask } from "../domain/tasks.js";
import { createProgram, getProgram } from "../domain/programs.js";
import { checkTargetInScope, evaluateTargetScope } from "./scopeChecker.js";
import { researchCandidatePrograms, extractProgramPolicy, runResearchSession, type ResearchAgentCandidateFinding } from "./researcher.js";
import { draftReport } from "./reporter.js";
import { requestApproval, requestFindingApproval } from "../telegram/bot.js";
import { log } from "../logging/logger.js";
import {
  startResearchSession,
  addQuery,
  addPageVisited,
  completeResearchSession,
  getResearchSession,
} from "../domain/researchSessions.js";
import { recordSourceEvidence } from "../domain/sourceEvidence.js";
import {
  createFinding,
  transitionFinding,
  setCandidateIntelligence,
  markSubmissionMode,
  listFindingsForProgram,
  getFinding,
} from "../domain/findings.js";
import { detectDuplicates } from "../domain/duplicateDetection.js";
import { createReport } from "../domain/reports.js";
import { createEarning } from "../domain/earnings.js";
import { listApprovals } from "../domain/approvals.js";
import type { Finding, Program, ProgramPolicy, Report, Task } from "../domain/types.js";

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

/**
 * Runs an already-created, program-less discovery task (task.type ===
 * 'research', task.programId === null). Split out from runDiscovery() so
 * the Scheduler can dequeue and execute a task a Planner enqueued earlier,
 * not just a task it creates and runs synchronously itself.
 */
export async function executeDiscoveryTask(task: Task): Promise<DiscoveryRunResult> {
  if (task.status === "queued") {
    transitionTask(task.id, "running", { timeoutAt: new Date(Date.now() + RESEARCH_TASK_TIMEOUT_MS).toISOString() });
  }
  log("task_started", { taskId: task.id });

  const result = await researchCandidatePrograms(task.target);

  if (!result.ok) {
    transitionTask(task.id, "failed", { failureReason: result.error ?? "Unknown research failure" });
    log("task_failed", { taskId: task.id, reason: result.error });
    return { task: getTask(task.id)!, summary: "", costUsd: result.costUsd };
  }

  const completed = transitionTask(task.id, "completed", { result: result.summary });
  log("task_completed", { taskId: task.id, costUsd: result.costUsd });
  return { task: completed, summary: result.summary, costUsd: result.costUsd };
}

/** Convenience wrapper: creates a fresh program-less discovery task and runs it immediately. No approval needed (section 13). */
export async function runDiscovery(topic: string): Promise<DiscoveryRunResult> {
  const task = createTask({ type: "research", target: topic });
  log("task_created", { taskId: task.id, type: task.type, target: task.target });
  return executeDiscoveryTask(task);
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
    policyVerifiedNow: true,
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

// --- v0.2: full research -> candidate -> approval -> report -> submission pipeline ---

const RESEARCH_TASK_TIMEOUT_MS = 10 * 60 * 1000;

function describeScope(policy: ProgramPolicy): string {
  return `In scope: ${policy.inScope.join(", ") || "(none published)"}. Out of scope: ${policy.outOfScope.join(", ") || "(none published)"}.`;
}

function describePolicy(policy: ProgramPolicy): string {
  return [
    `Automation allowed: ${policy.automationAllowed}.`,
    policy.allowedMethods.length ? `Allowed methods: ${policy.allowedMethods.join(", ")}.` : "",
    policy.forbiddenMethods.length ? `Forbidden methods: ${policy.forbiddenMethods.join(", ")}.` : "",
    policy.restrictions.length ? `Restrictions: ${policy.restrictions.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface RunResearchTaskResult {
  ok: boolean;
  task: Task;
  sessionId: string;
  findingsCreated: Finding[];
  costUsd: number;
  error?: string;
}

/**
 * The full Research Agent step wired into the task queue (project brief
 * section 4): runs a research session against a program's own context,
 * persists queries/pages/sources durably (resumable — the session row is
 * created before the (paid, networked) Claude call, so a crash mid-call
 * leaves a 'running' session rather than losing the goal entirely), then
 * for every candidate finding the agent proposes: checks scope, runs
 * deterministic duplicate detection, records the finding with its
 * intelligence attached, and — only for a non-duplicate, non-out-of-scope
 * candidate — requests Telegram approval to continue (section 20's Safe
 * Validation Gate).
 */
/**
 * Runs an already-created research task tied to a program (task.type ===
 * 'research', task.programId set). Split out from runResearchTask() so the
 * Scheduler can dequeue and execute a task a Planner enqueued earlier.
 */
export async function executeResearchTask(task: Task, previousResearchSummary?: string | null): Promise<RunResearchTaskResult> {
  if (!task.programId) throw new Error(`Task ${task.id} has no programId — use executeDiscoveryTask() instead.`);
  const program = getProgram(task.programId);
  if (!program) throw new Error(`Program not found: ${task.programId}`);

  if (task.status === "queued") {
    const timeoutAt = new Date(Date.now() + RESEARCH_TASK_TIMEOUT_MS).toISOString();
    transitionTask(task.id, "running", { timeoutAt });
  }
  log("task_started", { taskId: task.id });

  const session = startResearchSession({ programId: program.id, taskId: task.id, goal: task.target });
  log("research_session_started", { sessionId: session.id, taskId: task.id, goal: task.target });

  const result = await runResearchSession({
    goal: task.target,
    programContext: { name: program.name, url: program.url, scopeSummary: describeScope(program.policy), policySummary: describePolicy(program.policy) },
    previousResearchSummary,
  });

  if (!result.ok || !result.output) {
    completeResearchSession(session.id, { status: "failed", summary: result.error ?? "Research call failed" });
    transitionTask(task.id, "failed", { failureReason: result.error ?? "Research call failed" });
    log("task_failed", { taskId: task.id, reason: result.error });
    return { ok: false, task: getTask(task.id)!, sessionId: session.id, findingsCreated: [], costUsd: result.costUsd, error: result.error };
  }

  const output = result.output;
  for (const q of output.queriesRun) addQuery(session.id, q);
  for (const p of output.pagesVisited) addPageVisited(session.id, { url: p.url, title: p.title, capturedAt: new Date().toISOString() });
  for (const s of output.sourcesUsed) {
    recordSourceEvidence({ researchSessionId: session.id, sourceUrl: s.url, sourceType: s.sourceType, title: s.title, relevantExcerpt: s.excerpt });
  }

  const findingsCreated = createCandidateFindings(program, session.id, output.candidateFindings);

  completeResearchSession(session.id, {
    status: "completed",
    scopeObservations: output.scopeObservations,
    policyObservations: output.policyObservations,
    summary: output.researchSummary,
    nextRecommendedAction: output.nextRecommendedAction,
    confidence: output.confidence,
    candidateFindingIds: findingsCreated.map((f) => f.id),
  });
  log("research_session_completed", { sessionId: session.id, candidateCount: findingsCreated.length, officialSourceFound: output.officialSourceFound });

  const completed = transitionTask(task.id, "completed", {
    result: JSON.stringify({ sessionId: session.id, summary: output.researchSummary, candidateCount: findingsCreated.length }),
  });
  log("task_completed", { taskId: task.id, costUsd: result.costUsd });

  return { ok: true, task: completed, sessionId: session.id, findingsCreated, costUsd: result.costUsd };
}

/** Convenience wrapper: creates a fresh program-tied research task and runs it immediately. */
export async function runResearchTask(input: {
  programId: string;
  goal: string;
  previousResearchSummary?: string | null;
}): Promise<RunResearchTaskResult> {
  const program = getProgram(input.programId);
  if (!program) throw new Error(`Program not found: ${input.programId}`);

  const task = createTask({ type: "research", programId: program.id, target: input.goal });
  log("task_created", { taskId: task.id, type: task.type, programId: program.id, target: input.goal });

  return executeResearchTask(task, input.previousResearchSummary);
}

/**
 * Turns the Research Agent's proposed candidates into Finding rows: scope-
 * checks each one against the program (an out-of-scope candidate is marked
 * invalid immediately — it was never actionable), runs deterministic
 * duplicate detection (a likely duplicate is recorded but never advanced
 * automatically), and requests Telegram approval only for a genuinely novel,
 * in-scope-or-needs-review candidate.
 */
export function createCandidateFindings(program: Program, sessionId: string, candidates: ResearchAgentCandidateFinding[]): Finding[] {
  const created: Finding[] = [];

  for (const candidate of candidates) {
    const finding = createFinding({
      programId: program.id,
      title: candidate.title,
      asset: candidate.asset,
      summary: candidate.summary,
      category: candidate.category,
      researchSessionId: sessionId,
    });
    transitionFinding(finding.id, "candidate");
    log("finding_created", { findingId: finding.id, programId: program.id, sessionId });

    const scopeResult = evaluateTargetScope(program.id, candidate.asset);
    const duplicateResult = detectDuplicates(
      { asset: candidate.asset, category: candidate.category, title: candidate.title, summary: candidate.summary },
      listFindingsForProgram(program.id).filter((f) => f.id !== finding.id),
    );

    setCandidateIntelligence(finding.id, {
      confidence: candidate.confidence,
      confidenceReason: candidate.confidenceReason,
      duplicateVerdict: duplicateResult.verdict,
      duplicateOfFindingId: duplicateResult.matchedFindingId,
      severityCandidate: candidate.severityCandidate,
      severityReason: candidate.severityReason,
      severityConfidence: candidate.severityConfidence,
    });

    created.push(finding);

    if (scopeResult.verdict === "DENY") {
      transitionFinding(finding.id, "invalid");
      log("finding_status_changed", { findingId: finding.id, to: "invalid", reason: `Out of scope: ${scopeResult.reason}` });
      continue;
    }
    if (duplicateResult.verdict === "LIKELY_DUPLICATE") {
      log("finding_status_changed", { findingId: finding.id, note: "left as candidate — likely duplicate, not auto-advanced", matchedFindingId: duplicateResult.matchedFindingId });
      continue;
    }

    // Fire-and-forget: a Telegram delivery failure must not block finding creation.
    // (No `await` here would silently drop errors — we await but never let a
    // rejection propagate, since delivery failure is already reported via `delivered`.)
    void requestFindingApproval({
      findingId: finding.id,
      requestedAction: "Continue: mark this candidate validated and proceed to report drafting.",
      context: {
        findingNumber: finding.id.slice(0, 8),
        programName: program.name,
        target: candidate.asset,
        category: candidate.category,
        confidence: candidate.confidence,
        confidenceReason: candidate.confidenceReason,
        scopeVerdict: scopeResult.verdict,
        policyAllowed: program.policy.automationAllowed,
        requestedAction: "Continue approved validation",
      },
    }).catch((err) => log("task_failed", { note: "finding approval request threw unexpectedly", findingId: finding.id, error: (err as Error).message }));
  }

  return created;
}

export interface DraftReportForFindingResult {
  ok: boolean;
  finding: Finding;
  report: Report | null;
  error?: string;
  costUsd: number;
}

/**
 * Safe Next Step after a finding's first approval (section 20/26): moves the
 * finding past the (unimplemented, v0.2 has no active Validator) validation
 * gate on the strength of the human's approval, drafts a report from the
 * research notes on file, and requests a SEPARATE final approval before
 * anything is considered submittable — drafting a report is not itself
 * scope-sensitive, but treating it as submission-ready is.
 */
export async function draftReportForApprovedFinding(findingId: string): Promise<DraftReportForFindingResult> {
  const finding = getFinding(findingId);
  if (!finding) throw new Error(`Finding not found: ${findingId}`);
  if (finding.status !== "candidate") {
    throw new Error(`Finding ${findingId} is '${finding.status}', not 'candidate' — nothing to advance.`);
  }

  const approved = listApprovals("approved").find((a) => a.findingId === findingId);
  if (!approved) {
    throw new Error(`No approved Telegram approval found for finding ${findingId} — cannot proceed without human approval.`);
  }

  const program = getProgram(finding.programId);
  if (!program) throw new Error(`Program not found: ${finding.programId}`);

  transitionFinding(findingId, "validated");
  log("finding_status_changed", { findingId, to: "validated", note: "advanced on human approval; no automated validation was performed (v0.2 has no Validator)" });

  const session = finding.researchSessionId ? getResearchSession(finding.researchSessionId) : null;
  const researchNotes = [
    `Summary: ${finding.summary}`,
    `Category: ${finding.category ?? "unknown"}`,
    `Severity candidate: ${finding.severityCandidate ?? "unassessed"} (${finding.severityReason ?? "no reason given"})`,
    session ? `Research session summary: ${session.summary}` : "",
    session ? `Scope observations: ${session.scopeObservations}` : "",
    session ? `Policy observations: ${session.policyObservations}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const drafted = await draftReport(program, finding, researchNotes);
  if (!drafted.ok || !drafted.fields) {
    return { ok: false, finding: getFinding(findingId)!, report: null, error: drafted.error, costUsd: drafted.costUsd };
  }

  const report = createReport({
    findingId,
    title: drafted.fields.title,
    program: program.name,
    asset: finding.asset,
    summary: drafted.fields.summary,
    impact: drafted.fields.impact,
    stepsToReproduce: drafted.fields.stepsToReproduce,
    evidence: drafted.fields.evidence,
    expectedBehavior: drafted.fields.expectedBehavior,
    observedBehavior: drafted.fields.observedBehavior,
    suggestedRemediation: drafted.fields.suggestedRemediation,
    references: drafted.fields.references,
  });
  log("report_drafted", { findingId, reportId: report.id, costUsd: drafted.costUsd });

  transitionFinding(findingId, "report_draft");

  await requestApproval({
    findingId,
    requestedAction: `FINAL APPROVAL: submit the drafted report for finding "${finding.title}" (${program.name}). Submission will be recorded as SIMULATED — no real platform API is called.`,
    context: { programName: program.name, asset: finding.asset, actionDescription: "Final report submission (SIMULATED)" },
  }).catch((err) => log("task_failed", { note: "final approval request threw unexpectedly", findingId, error: (err as Error).message }));

  return { ok: true, finding: getFinding(findingId)!, report, costUsd: drafted.costUsd };
}

export interface SimulatedSubmissionResult {
  finding: Finding;
  earningId: string;
}

/**
 * Submission Gate (section 28): only callable once a SEPARATE final Telegram
 * approval exists for this finding (not the same approval that authorized
 * report drafting). Always records submissionMode = 'SIMULATED' — v0.2 has
 * no real platform API integration, and this project never fabricates a
 * real submission (section 21, 28).
 */
export function simulateSubmission(findingId: string): SimulatedSubmissionResult {
  const finding = getFinding(findingId);
  if (!finding) throw new Error(`Finding not found: ${findingId}`);
  if (finding.status !== "report_draft") {
    throw new Error(`Finding ${findingId} is '${finding.status}', not 'report_draft' — nothing to submit.`);
  }

  const finalApproval = listApprovals("approved").find(
    (a) => a.findingId === findingId && a.requestedAction.startsWith("FINAL APPROVAL"),
  );
  if (!finalApproval) {
    throw new Error(`No final approval found for finding ${findingId} — refusing to simulate submission.`);
  }

  transitionFinding(findingId, "submitted");
  markSubmissionMode(findingId, "SIMULATED");

  const earning = createEarning({ findingId, programId: finding.programId, bountyStatus: "pending" });

  log("submission_completed", { findingId, mode: "SIMULATED", earningId: earning.id });

  return { finding: getFinding(findingId)!, earningId: earning.id };
}

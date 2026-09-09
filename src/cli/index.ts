#!/usr/bin/env node
import { Command } from "commander";
import { listPrograms, createProgram, getProgram } from "../domain/programs.js";
import { listTasks, getTask, cancelTask } from "../domain/tasks.js";
import { listFindings, getFinding } from "../domain/findings.js";
import { listApprovals, getApproval } from "../domain/approvals.js";
import { summarizeEarnings, markAwarded, markPaid, getEarning } from "../domain/earnings.js";
import { recordRevenueAudit } from "../domain/revenueAudit.js";
import { createGoal, listGoalProgress } from "../domain/goals.js";
import { checkGoalMilestones } from "../domain/goalAlerts.js";
import { recordCost } from "../domain/costs.js";
import { bountyAwardedAlert, bountyPaidAlert, goalMilestoneAlert } from "../agent/alerts.js";
import { finishRun, listRuns, listRunningRuns } from "../domain/agentRuns.js";
import { getSchedulerState } from "../domain/schedulerState.js";
import { runDiscovery, onboardProgramFromPolicyPage, finalizeApprovedTask, runResearchTask, draftReportForApprovedFinding, simulateSubmission } from "../agent/orchestrator.js";
import { discoverAndCreateCandidates, researchCandidate, activateCandidateForResearch } from "../services/programResearch.js";
import { listCandidates, getCandidate, compareCandidates, selectCandidate, confirmAuthorization, cancelCandidate, getSafetyState } from "../domain/programCandidates.js";
import { runWorkerLoop, runOnce, pauseAgent, resumeAgent, stopAgent } from "../agent/scheduler.js";
import { runStartupRecovery } from "../agent/startupRecovery.js";
import { installDaemon, uninstallDaemon, getDaemonStatus } from "../agent/daemon.js";
import { checkHealth } from "../services/health.js";
import { handleApprovalDecision } from "../telegram/approvalHandler.js";
import { sendDailySummary, sendWeeklySummary } from "../telegram/bot.js";
import { buildDailySummary, formatDailySummaryMessage, buildWeeklySummary, formatWeeklySummaryMessage } from "../telegram/dailySummary.js";
import { backupDatabase, verifyBackup, restoreDatabase } from "../services/backup.js";
import { getAgentStatus, getProgramStats, getFindingStats, getRevenueTimeline } from "../services/dashboard.js";
import { getMetrics, getROI } from "../services/metrics.js";
import { telegramConfigStatus } from "../config/env.js";
import * as safari from "../safari/controller.js";
import { log } from "../logging/logger.js";

const program = new Command();
program.name("bba").description("Bug Bounty Agent v0.2 CLI").version("0.2.0");

// --- agent ---
const agent = program.command("agent").description("Agent runtime lifecycle");

agent
  .command("start")
  .description("Runs the worker loop (Scheduler -> Planner -> Task -> Result -> Next Task) until the queue is empty or a run limit is hit. Never unbounded.")
  .option("--daemon", "Use longer default run limits for longer-lived operation — still bounded, see docs/scheduler.md", false)
  .option("--max-tasks <n>", "Override max tasks this run")
  .option("--max-runtime-min <n>", "Override max runtime in minutes this run")
  .option("--max-browser-ops <n>", "Override max Safari operations this run")
  .option("--max-retries <n>", "Override max recovery retries per task this run")
  .action(async (opts) => {
    const recovery = runStartupRecovery();
    if (recovery.recoveredTaskIds.length || recovery.recoveredResearchSessionIds.length || recovery.expiredApprovalCount || recovery.schedulerStateReset) {
      console.log(
        `Startup recovery: ${recovery.recoveredTaskIds.length} task(s), ${recovery.recoveredResearchSessionIds.length} research session(s) recovered, ${recovery.expiredApprovalCount} approval(s) expired, scheduler reset: ${recovery.schedulerStateReset}`,
      );
    }
    console.log(`Telegram approval gateway: ${telegramConfigStatus()}`);
    const limits = {
      maxTasksPerRun: opts.maxTasks ? Number(opts.maxTasks) : opts.daemon ? 100 : undefined,
      maxRuntimeMs: opts.maxRuntimeMin ? Number(opts.maxRuntimeMin) * 60_000 : opts.daemon ? 8 * 60 * 60 * 1000 : undefined,
      maxBrowserOps: opts.maxBrowserOps ? Number(opts.maxBrowserOps) : undefined,
      maxRetries: opts.maxRetries ? Number(opts.maxRetries) : undefined,
    };
    const summary = await runWorkerLoop(limits);
    console.log(`Worker loop finished: ${summary.tasksExecuted} task(s) executed. Stopped: ${summary.stoppedReason}`);
  });

agent
  .command("run-once")
  .description("Runs exactly one task from the queue (or reports there's nothing to do) and exits.")
  .action(async () => {
    const result = await runOnce();
    if (!result.ranTask) {
      console.log("Nothing to do — queue is empty.");
      return;
    }
    console.log(`Task ${result.taskId}: ${result.outcome}`);
  });

agent
  .command("pause")
  .description("Blocks new task execution. In-flight approvals and queued work are preserved untouched.")
  .action(() => {
    const state = pauseAgent();
    console.log(`Scheduler -> ${state.status}`);
  });

agent
  .command("resume")
  .description("Resumes a paused scheduler.")
  .action(() => {
    const state = resumeAgent();
    console.log(`Scheduler -> ${state.status}`);
  });

agent
  .command("stop")
  .description("Stops the scheduler and marks any in-progress manual agent runs as completed (bookkeeping).")
  .action(() => {
    const state = stopAgent();
    const running = listRunningRuns();
    for (const run of running) {
      finishRun(run.id, "completed", "Stopped via CLI");
      log("agent_stopped", { runId: run.id });
    }
    console.log(`Scheduler -> ${state.status}. Closed ${running.length} bookkeeping run(s).`);
  });

agent
  .command("status")
  .description("Show scheduler state, agent run history, and current counts")
  .action(async () => {
    const scheduler = getSchedulerState();
    const status = await getAgentStatus();
    console.log(`Scheduler: ${scheduler.status.toUpperCase()}`);
    console.log(
      `Worker process: ${status.workerProcessRunning ? `RUNNING (pid ${status.workerProcessPid})` : "NOT RUNNING"}${
        !status.workerProcessRunning && scheduler.status === "running" ? "  <-- scheduler flag says running, but nothing is actually consuming the queue; run `bba agent start` or Telegram /run" : ""
      }`,
    );
    console.log(`Current task: ${scheduler.currentTaskId ?? "none"}`);
    console.log(`Browser: ${status.browserAvailable ? "AVAILABLE" : "UNAVAILABLE"}`);
    console.log(`Last research: ${status.lastResearchGoal ?? "none yet"}`);
    console.log("");

    const runs = listRuns().slice(0, 5);
    console.log("Recent agent runs:");
    for (const r of runs) console.log(`  ${r.id}  ${r.kind}  ${r.status}  started=${r.startedAt}`);
    console.log("");
    console.log(`Programs: ${listPrograms().length}`);
    console.log(`Tasks: ${listTasks().length} (queued=${status.queueDepth}, waiting_approval=${listTasks("waiting_approval").length})`);
    console.log(`Findings: ${listFindings().length}`);
    console.log(`Pending approvals: ${status.pendingApprovals}`);
    console.log(`Telegram approval gateway: ${telegramConfigStatus()}`);
  });

agent
  .command("health")
  .description("Runs all health checks (SQLite, Claude CLI, Safari, Telegram, Scheduler, Queue) and reports OK/DEGRADED/FAILED")
  .action(async () => {
    const report = await checkHealth();
    console.log(`Overall: ${report.overall}`);
    for (const c of report.checks) console.log(`  ${c.component}: ${c.status} — ${c.detail}`);
    if (report.overall === "FAILED") process.exitCode = 1;
  });

agent
  .command("restart")
  .description("Runs startup recovery, then the worker loop (equivalent to stop + start).")
  .action(async () => {
    stopAgent();
    const recovery = runStartupRecovery();
    console.log(
      `Startup recovery: ${recovery.recoveredTaskIds.length} task(s), ${recovery.recoveredResearchSessionIds.length} research session(s) recovered, ${recovery.expiredApprovalCount} approval(s) expired.`,
    );
    const summary = await runWorkerLoop({});
    console.log(`Worker loop finished: ${summary.tasksExecuted} task(s) executed. Stopped: ${summary.stoppedReason}`);
  });

// --- agent daemon (launchd, macOS) ---
const daemonCmd = agent.command("daemon").description("Persistent local runtime via macOS launchd — see docs/daemon.md");

daemonCmd
  .command("install")
  .description("Writes a launchd plist and loads it. RunAtLoad=true means this starts the agent running immediately — a deliberate, explicit action.")
  .action(() => {
    const result = installDaemon(process.cwd());
    console.log(`Plist written: ${result.plistPath}`);
    console.log(`Loaded: ${result.loaded}${result.error ? ` (${result.error})` : ""}`);
    console.log(`Run \`bba agent daemon status\` to check, \`bba agent daemon uninstall\` to remove.`);
  });

daemonCmd
  .command("uninstall")
  .description("Unloads and removes the launchd plist.")
  .action(() => {
    const result = uninstallDaemon();
    console.log(`Removed: ${result.removed}${result.error ? ` (unload warning: ${result.error})` : ""}`);
  });

daemonCmd
  .command("status")
  .description("Checks whether the launchd plist is installed and registered.")
  .action(() => {
    const status = getDaemonStatus();
    console.log(`Plist installed: ${status.plistInstalled}`);
    console.log(`Registered with launchd: ${status.registeredWithLaunchd}`);
    console.log(`PID: ${status.pid ?? "not running"}`);
  });

// --- program ---
const programCmd = program.command("program").description("Bug bounty program management");

programCmd
  .command("list")
  .description("List programs")
  .action(() => {
    for (const p of listPrograms()) {
      console.log(`${p.id}  [${p.status}]  ${p.name}  (${p.platform})  automation=${p.policy.automationAllowed}`);
    }
  });

programCmd
  .command("add")
  .description("Add a program. With --policy-url, Claude reads and extracts scope via Safari MCP; otherwise scope is entered manually.")
  .requiredOption("--name <name>", "Program name")
  .requiredOption("--platform <platform>", "Platform, e.g. HackerOne, Bugcrowd, self-hosted")
  .option("--policy-url <url>", "Public policy/scope page URL — triggers agent-assisted extraction")
  .option("--url <url>", "Program URL (used verbatim with manual entry)")
  .option("--in-scope <items>", "Comma-separated in-scope patterns (manual entry)")
  .option("--out-of-scope <items>", "Comma-separated out-of-scope patterns (manual entry)")
  .option("--automation-allowed", "Program policy explicitly permits automated tooling (manual entry)", false)
  .action(async (opts) => {
    if (opts.policyUrl) {
      try {
        const result = await onboardProgramFromPolicyPage({ name: opts.name, platform: opts.platform, policyUrl: opts.policyUrl });
        if (!result.ok) {
          console.error(`Failed: ${result.reason}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Program created: ${result.program!.id} (status=${result.program!.status})`);
        console.log(`Task: ${result.task?.id} (status=${result.task?.status})`);
        console.log(`Scope check: ${result.reason}`);
        console.log(`Telegram approval requested: ${result.approvalRequested}`);
        console.log(`Claude cost: $${result.costUsd.toFixed(4)}`);
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        console.error("(The program/task may have already been recorded — check `bba program list` / `bba task list`.)");
        process.exitCode = 1;
      }
      return;
    }

    const p = createProgram({
      name: opts.name,
      platform: opts.platform,
      url: opts.url ?? "",
      status: "active",
      policy: {
        inScope: (opts.inScope ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
        outOfScope: (opts.outOfScope ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
        allowedMethods: [],
        forbiddenMethods: [],
        automationAllowed: Boolean(opts.automationAllowed),
        restrictions: [],
      },
    });
    console.log(`Program created: ${p.id}`);
  });

programCmd
  .command("research <programId> <goal>")
  .description("Runs a full Research Agent session against a program (Safari + Claude), creating candidate findings and requesting approval for each novel one.")
  .action(async (programId: string, goal: string) => {
    const result = await runResearchTask({ programId, goal });
    console.log(`Task ${result.task.id} -> ${result.task.status}`);
    console.log(`Research session: ${result.sessionId}`);
    console.log(`Candidate findings created: ${result.findingsCreated.length}`);
    for (const f of result.findingsCreated) console.log(`  ${f.id}  [${f.status}]  ${f.title}`);
    console.log(`Cost: $${result.costUsd.toFixed(4)}`);
    if (!result.ok) {
      console.error(`Failed: ${result.error}`);
      process.exitCode = 1;
    }
  });

// --- program candidate discovery / enrollment preparation (v0.3.2) ---
// NOT ENROLLED by default: nothing here ever touches a live target. Only
// `program activate-candidate` (the final step, after human-confirmed
// authorization) creates a real, live-testable `programs` row.

programCmd
  .command("discover <topic>")
  .description("Searches the public web for candidate bug bounty programs (Safari, read-only) and records each as a new candidate (or dedups against an existing one).")
  .action(async (topic: string) => {
    const result = await discoverAndCreateCandidates(topic);
    if (!result.ok) {
      console.error(`Discovery failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Found ${result.created.length} new candidate(s), ${result.deduped} already known.`);
    for (const c of result.created) console.log(`  ${c.id}  ${c.name}  (${c.platform})  ${c.officialUrl}`);
    console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  });

programCmd
  .command("candidates")
  .option("--stage <stage>", "Filter by stage (discovered|researched|candidate|enrollment_pending|authorized|ready_for_research)")
  .description("Lists program candidates and their enrollment stage. NOT the same as `program list` — none of these are live-testable yet.")
  .action((opts) => {
    const candidates = listCandidates(opts.stage ? { stage: opts.stage } : {});
    for (const c of candidates) console.log(`${c.id}  [${c.stage}]  ${c.name}  (${c.platform})`);
  });

programCmd
  .command("candidate <id>")
  .description("Shows one candidate's full researched detail.")
  .action((id: string) => {
    const c = getCandidate(id);
    if (!c) {
      console.error("Candidate not found.");
      process.exitCode = 1;
      return;
    }
    console.log(`${c.name}  (${c.platform})  stage=${c.stage}`);
    console.log(`Official URL: ${c.officialUrl}`);
    console.log(`Public: ${c.publicOrPrivate}  Automation: ${c.automationPolicy}`);
    console.log(`Scope clarity: ${c.scopeClarity}  Policy clarity: ${c.policyClarity}  Reward transparency: ${c.rewardTransparency}`);
    if (c.scopeSummary) console.log(`Scope: ${c.scopeSummary}`);
    if (c.policySummary) console.log(`Policy: ${c.policySummary}`);
    if (c.rewardSummary) console.log(`Reward: ${c.rewardSummary}`);
    console.log(`Eligibility: ${JSON.stringify(c.eligibility)}`);
    if (c.risks) console.log(`Risks: ${c.risks}`);
    if (c.enrollmentRequirements) console.log(`Enrollment requirements: ${c.enrollmentRequirements}`);
    console.log(`Sources: ${c.sources.length}`);
    const safety = getSafetyState(c);
    console.log(`Live testing: ${safety.blocked ? `BLOCKED (${safety.reasons.join(", ")})` : "unblocked"}`);
  });

programCmd
  .command("compare")
  .description("Ranks all candidates by decision-support score (never by reward alone — section 10).")
  .action(() => {
    const ranked = compareCandidates(listCandidates());
    if (ranked.length === 0) {
      console.log("No candidates yet — run `bba program discover \"<topic>\"` first.");
      return;
    }
    ranked.forEach((r, i) => {
      console.log(`${i + 1}. ${r.candidate.name} (${r.candidate.platform}) — ${r.score}/100`);
      console.log(`   ${r.reason}`);
    });
  });

programCmd
  .command("research-candidate <id>")
  .description("Deep-dive research on one candidate (Safari, read-only): scope, policy, automation policy, rewards, eligibility. Never touches a live target.")
  .action(async (id: string) => {
    const result = await researchCandidate(id);
    if (!result.ok || !result.candidate) {
      console.error(`Research failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${result.candidate.name} -> stage=${result.candidate.stage}`);
    console.log(`Scope clarity: ${result.candidate.scopeClarity}  Policy clarity: ${result.candidate.policyClarity}  Automation: ${result.candidate.automationPolicy}`);
    console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  });

programCmd
  .command("select-candidate <id>")
  .description("Human Selection Gate (section 14): marks one candidate as selected and generates its enrollment checklist. The agent never signs up or accepts terms on your behalf.")
  .action((id: string) => {
    try {
      const updated = selectCandidate(id, "cli-local-operator");
      console.log(`${updated.name} -> ${updated.stage}`);
      console.log("Enrollment checklist:");
      for (const item of updated.enrollmentChecklist) console.log(`  [ ] ${item.item}`);
      console.log("\nComplete these yourself, then run `bba program authorize-candidate <id>` once you've actually enrolled.");
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

programCmd
  .command("authorize-candidate <id>")
  .description('Records your self-report that you have completed enrollment ("I have enrolled"). This is NEVER independently verified against the platform — see section 18.')
  .action((id: string) => {
    try {
      const updated = confirmAuthorization(id, "cli-local-operator");
      console.log(`${updated.name} -> ${updated.stage} (self-reported, not independently verified)`);
      console.log("Live testing is still BLOCKED. Run `bba program activate-candidate <id>` to re-verify the policy and go live.");
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

programCmd
  .command("activate-candidate <id>")
  .description("Authorization Gate / Live Target Lock release (sections 19-20): re-verifies the published policy right now (Safari), then creates the real, live-testable program. Requires the candidate to already be 'authorized'.")
  .action(async (id: string) => {
    const result = await activateCandidateForResearch(id);
    if (!result.ok || !result.result) {
      console.error(`Activation failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Live program created: ${result.result.program.id} (status=${result.result.program.status})`);
    console.log(`Candidate ${result.result.candidate.id} -> ${result.result.candidate.stage}, linked to ${result.result.candidate.linkedProgramId}`);
    console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  });

programCmd
  .command("cancel-candidate <id>")
  .option("--reason <reason>", "Why you're cancelling", "")
  .description("Cancels a candidate before enrollment. Refuses once it's already been activated into a live program.")
  .action((id: string, opts) => {
    const result = cancelCandidate(id, opts.reason);
    console.log(result.reason);
    if (!result.ok) process.exitCode = 1;
  });

// --- task ---
const taskCmd = program.command("task").description("Task queue management");

taskCmd
  .command("list")
  .option("--status <status>", "Filter by status")
  .action((opts) => {
    for (const t of listTasks(opts.status)) {
      console.log(`${t.id}  [${t.status}]  ${t.type}  target=${t.target}  program=${t.programId ?? "-"}`);
    }
  });

taskCmd
  .command("run <id>")
  .description("Finalize a task that is currently 'approved' (completes it and records the result)")
  .action((id: string) => {
    const task = getTask(id);
    if (!task) {
      console.error("Task not found.");
      process.exitCode = 1;
      return;
    }
    if (task.status !== "approved") {
      console.log(`Task ${id} is '${task.status}', not 'approved' — nothing to finalize.`);
      return;
    }
    const done = finalizeApprovedTask(id, task.result ?? "Approved and finalized via CLI.");
    console.log(`Task ${done.id} -> ${done.status}`);
  });

taskCmd
  .command("cancel <id>")
  .option("--reason <reason>", "Reason for cancellation", "Cancelled via CLI")
  .action((id: string, opts) => {
    const cancelled = cancelTask(id, opts.reason);
    console.log(`Task ${cancelled.id} -> ${cancelled.status}`);
  });

taskCmd
  .command("research <topic>")
  .description("Run a program-less public research task (Safari search + read, no approval needed)")
  .action(async (topic: string) => {
    const result = await runDiscovery(topic);
    console.log(`Task ${result.task.id} -> ${result.task.status}`);
    console.log(`Cost: $${result.costUsd.toFixed(4)}`);
    console.log("");
    console.log(result.summary);
  });

// --- finding ---
const findingCmd = program.command("finding").description("Finding lifecycle");

findingCmd
  .command("list")
  .option("--status <status>", "Filter by status")
  .action((opts) => {
    // Bounty state lives on the Earning ledger, not Finding.bountyStatus —
    // see `bba earnings summary` / `dashboard status` for real paid figures.
    for (const f of listFindings(opts.status)) {
      console.log(`${f.id}  [${f.status}]  ${f.title}  asset=${f.asset}`);
    }
  });

findingCmd
  .command("show <id>")
  .action((id: string) => {
    const f = getFinding(id);
    if (!f) {
      console.error("Finding not found.");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(f, null, 2));
  });

findingCmd
  .command("draft-report <id>")
  .description("Advances an approved candidate finding (candidate -> validated -> report_draft) and drafts its report, then requests final approval.")
  .action(async (id: string) => {
    const result = await draftReportForApprovedFinding(id);
    console.log(`Finding ${result.finding.id} -> ${result.finding.status}`);
    if (!result.ok) {
      console.error(`Failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Report drafted: ${result.report!.id} — "${result.report!.title}"`);
    console.log(`Cost: $${result.costUsd.toFixed(4)}`);
    console.log("Final Telegram approval requested (SIMULATED submission gate).");
  });

findingCmd
  .command("submit <id>")
  .description("Records a SIMULATED submission for a finding once its FINAL approval is granted. Never calls a real platform API.")
  .action((id: string) => {
    try {
      const result = simulateSubmission(id);
      console.log(`Finding ${result.finding.id} -> ${result.finding.status} (submissionMode=${result.finding.submissionMode})`);
      console.log(`Earning record: ${result.earningId} (bountyStatus=pending)`);
    } catch (err) {
      console.error(`Failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// --- approval ---
const approvalCmd = program.command("approval").description("Human approval queue");

approvalCmd
  .command("list")
  .option("--status <status>", "Filter by status (default: pending)", "pending")
  .action((opts) => {
    for (const a of listApprovals(opts.status)) {
      console.log(`${a.id}  [${a.status}]  task=${a.taskId ?? "-"}  finding=${a.findingId ?? "-"}  action="${a.requestedAction}"`);
    }
  });

approvalCmd
  .command("decide <id> <decision>")
  .description("Local fallback for approve|reject when Telegram isn't configured. Still enforces the allowlist via --telegram-user-id.")
  .requiredOption("--telegram-user-id <id>", "Must be an id in TELEGRAM_ALLOWED_USER_IDS")
  .action((id: string, decision: string, opts) => {
    if (decision !== "approve" && decision !== "reject") {
      console.error('Decision must be "approve" or "reject".');
      process.exitCode = 1;
      return;
    }
    const approval = getApproval(id);
    if (!approval) {
      console.error("Approval not found.");
      process.exitCode = 1;
      return;
    }
    const result = handleApprovalDecision(id, decision === "approve" ? "approved" : "rejected", opts.telegramUserId);
    console.log(result.reason);
    if (!result.ok) process.exitCode = 1;
  });

// --- earnings ---
const earningsCmd = program.command("earnings").description("Bounty earnings tracking");

earningsCmd
  .command("summary")
  .description("Realized-income summary. Only bountyStatus=paid counts toward totals.")
  .action(() => {
    const s = summarizeEarnings();
    console.log(`Today:      $${s.today.toFixed(2)}`);
    console.log(`This month: $${s.thisMonth.toFixed(2)}`);
    console.log(`All time:   $${s.allTime.toFixed(2)}  (paid only)`);
    console.log(`Pending:    $${s.pending.toFixed(2)}  (awarded but not yet paid)`);
  });

earningsCmd
  .command("award <earningId>")
  .requiredOption("--amount <amount>", "Bounty amount")
  .requiredOption("--currency <currency>", "e.g. USD")
  .option("--who <who>", "Telegram user id or operator name, for the revenue audit trail", "cli-local-operator")
  .option("--reason <reason>", "Why — e.g. 'program confirmed via email'", "")
  .description("Records that a bounty was awarded (not yet paid — see `earnings pay`). This is a manual bookkeeping step; there is no platform API integration.")
  .action(async (earningId: string, opts) => {
    const before = getEarning(earningId);
    const earning = markAwarded(earningId, { amount: Number(opts.amount), currency: opts.currency });
    recordRevenueAudit({
      earningId,
      who: opts.who,
      what: "marked awarded",
      source: "cli",
      previousValue: before ? { bountyStatus: before.bountyStatus, amount: before.amount, currency: before.currency } : null,
      newValue: { bountyStatus: "awarded", amount: earning.amount, currency: earning.currency },
      reason: opts.reason,
    });
    console.log(`Earning ${earning.id} -> awarded ($${earning.amount} ${earning.currency})`);
    const program = getProgram(earning.programId);
    await bountyAwardedAlert(program?.name ?? "unknown program", earning.amount ?? 0, earning.currency ?? "USD");
  });

earningsCmd
  .command("pay <earningId>")
  .option("--verification-source <source>", "How this was confirmed (e.g. 'checked HackerOne dashboard 2026-09-09'). Omit to leave UNVERIFIED.")
  .option("--who <who>", "Telegram user id or operator name, for the revenue audit trail", "cli-local-operator")
  .description("Records that an already-awarded bounty was actually paid. Only PAID counts toward realized revenue (section 45 — never fabricated). Stays UNVERIFIED unless --verification-source is given.")
  .action(async (earningId: string, opts) => {
    const existing = getEarning(earningId);
    if (!existing) {
      console.error("Earning not found.");
      process.exitCode = 1;
      return;
    }
    const earning = markPaid(earningId, opts.verificationSource);
    recordRevenueAudit({
      earningId,
      who: opts.who,
      what: "marked paid",
      source: "cli",
      previousValue: { bountyStatus: existing.bountyStatus },
      newValue: { bountyStatus: "paid", verificationStatus: earning.verificationStatus },
      reason: opts.verificationSource ?? "",
    });
    console.log(`Earning ${earning.id} -> paid ($${earning.amount} ${earning.currency}), verification=${earning.verificationStatus}`);

    const program = getProgram(earning.programId);
    await bountyPaidAlert(program?.name ?? "unknown program", earning.amount ?? 0, earning.currency ?? "USD", earning.verificationStatus === "VERIFIED");

    const milestones = checkGoalMilestones();
    for (const m of milestones) {
      console.log(`Goal milestone: "${m.progress.goal.name}" reached ${m.thresholdPct}%`);
      await goalMilestoneAlert(m.progress.goal.name, m.thresholdPct);
    }
  });

earningsCmd
  .command("goal-add <name>")
  .requiredOption("--target <amount>", "Target amount")
  .requiredOption("--currency <currency>", "e.g. USD or KRW")
  .description("Adds a revenue goal. Progress is computed from PAID earnings only, in this exact currency.")
  .action((name: string, opts) => {
    const goal = createGoal({ name, targetAmount: Number(opts.target), targetCurrency: opts.currency });
    console.log(`Goal created: ${goal.id} — ${goal.name} (${goal.targetAmount} ${goal.targetCurrency})`);
  });

earningsCmd
  .command("goals")
  .description("Lists active goals with progress (PAID / target, same currency only).")
  .action(() => {
    for (const g of listGoalProgress()) {
      const pct = Math.round(g.progressRatio * 100);
      console.log(`${g.goal.name}: ${g.paidInGoalCurrency} / ${g.goal.targetAmount} ${g.goal.targetCurrency} (${pct}%)`);
    }
  });

earningsCmd
  .command("cost-add")
  .requiredOption("--category <category>", "claude_api | infrastructure | hosting | other")
  .requiredOption("--amount <amount>", "Amount")
  .option("--currency <currency>", "Currency", "USD")
  .option("--note <note>", "Note", "")
  .description("Records a real, measured cost (never an estimate) toward Net Revenue.")
  .action((opts) => {
    const cost = recordCost({ category: opts.category, amount: Number(opts.amount), currency: opts.currency, note: opts.note });
    console.log(`Cost recorded: ${cost.id} — ${cost.category} ${cost.amount} ${cost.currency}`);
  });

// --- safari ---
const safariCmd = program.command("safari").description("Safari MCP controller diagnostics");

safariCmd
  .command("status")
  .description("Checks whether Safari is reachable via AppleScript automation")
  .action(async () => {
    try {
      const tab = await safari.currentTab();
      console.log(`OK — Safari reachable. Current tab: ${tab.title} (${tab.url})`);
    } catch (err) {
      console.error(`FAIL — could not reach Safari via osascript: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

// --- dashboard (backend services, section 37 — no web UI in v0.2) ---
const dashboardCmd = program.command("dashboard").description("Dashboard backend data, printed to the terminal");

dashboardCmd
  .command("status")
  .description("Program/finding/earnings stats, metrics, and ROI (revenue-per-hour only shown when real elapsed agent-run time exists)")
  .action(() => {
    const programStats = getProgramStats();
    const findingStats = getFindingStats();
    const earnings = summarizeEarnings();
    const metrics = getMetrics();
    const roi = getROI();
    const timeline = getRevenueTimeline();

    console.log("Programs:", JSON.stringify(programStats));
    console.log("Findings:", JSON.stringify(findingStats));
    console.log("Earnings (paid-only totals):", JSON.stringify(earnings));
    console.log("Metrics:", JSON.stringify(metrics));
    console.log(`ROI: revenue/session=${roi.revenuePerSession ?? "n/a"} revenue/task=${roi.revenuePerTask ?? "n/a"} revenue/hour=${roi.revenuePerHour ?? "n/a (no tracked runtime yet)"}`);
    console.log(`Revenue timeline (${timeline.length} day(s) with paid revenue):`, JSON.stringify(timeline));
  });

dashboardCmd
  .command("serve")
  .description("Starts the web dashboard (binds to 127.0.0.1 only — see docs/dashboard.md)")
  .option("--port <port>", "Port to listen on", "4173")
  .action(async (opts) => {
    const { startWebDashboard } = await import("../web/server.js");
    startWebDashboard(Number(opts.port));
  });

// --- telegram ---
const telegramCmd = program.command("telegram").description("Telegram approval gateway utilities");

telegramCmd
  .command("daily-summary")
  .description("Sends the daily agent report to Telegram if configured, otherwise prints it locally.")
  .action(async () => {
    const summary = buildDailySummary();
    const text = formatDailySummaryMessage(summary);
    if (telegramConfigStatus() !== "ready") {
      console.log("Telegram not configured — printing locally instead:\n");
      console.log(text);
      return;
    }
    await sendDailySummary();
    console.log("Daily summary sent to Telegram.");
  });

telegramCmd
  .command("weekly-summary")
  .description("Sends the weekly agent report to Telegram if configured, otherwise prints it locally.")
  .action(async () => {
    const summary = buildWeeklySummary();
    const text = formatWeeklySummaryMessage(summary);
    if (telegramConfigStatus() !== "ready") {
      console.log("Telegram not configured — printing locally instead:\n");
      console.log(text);
      return;
    }
    await sendWeeklySummary();
    console.log("Weekly summary sent to Telegram.");
  });

// --- db (backup/restore, section 59) ---
const dbCmd = program.command("db").description("Local SQLite backup/restore");

dbCmd
  .command("backup")
  .option("--out <path>", "Destination file (default: data/backups/backup-<timestamp>.sqlite)")
  .description("Creates a consistent backup (VACUUM INTO) and verifies it's actually readable before reporting success.")
  .action((opts) => {
    const result = backupDatabase(opts.out);
    console.log(`Backup written: ${result.path} (${result.sizeBytes} bytes)`);
    console.log(`Verified table counts: ${JSON.stringify(result.tableCounts)}`);
  });

dbCmd
  .command("verify-backup <path>")
  .description("Opens a backup file read-only and confirms it's a valid, readable database.")
  .action((path: string) => {
    const result = verifyBackup(path);
    console.log(`Valid: ${result.ok}`);
    if (result.ok) console.log(`Table counts: ${JSON.stringify(result.tableCounts)}`);
    else console.error(`Error: ${result.error}`);
    if (!result.ok) process.exitCode = 1;
  });

dbCmd
  .command("restore <path>")
  .description("Restores from a backup file onto the live database. Takes a safety backup of the current live file first (never restores blind).")
  .action((path: string) => {
    const result = restoreDatabase(path);
    console.log(`Restored to: ${result.restoredTo}`);
    console.log(`Pre-restore safety backup: ${result.safetyBackupPath}`);
  });

program.parseAsync(process.argv);

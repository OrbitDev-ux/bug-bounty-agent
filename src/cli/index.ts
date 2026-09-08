#!/usr/bin/env node
import { Command } from "commander";
import { listPrograms, createProgram } from "../domain/programs.js";
import { listTasks, getTask, cancelTask } from "../domain/tasks.js";
import { listFindings, getFinding } from "../domain/findings.js";
import { listApprovals } from "../domain/approvals.js";
import { summarizeEarnings } from "../domain/earnings.js";
import { startRun, finishRun, listRuns, listRunningRuns } from "../domain/agentRuns.js";
import { runDiscovery, onboardProgramFromPolicyPage, finalizeApprovedTask } from "../agent/orchestrator.js";
import { telegramConfigStatus } from "../config/env.js";
import * as safari from "../safari/controller.js";
import { log } from "../logging/logger.js";

const program = new Command();
program.name("bba").description("Bug Bounty Agent v0.1 CLI").version("0.1.0");

// --- agent ---
const agent = program.command("agent").description("Agent runtime lifecycle");

agent
  .command("start")
  .description("Record the start of a manual agent run (bookkeeping; does not daemonize)")
  .action(() => {
    const run = startRun("manual");
    log("agent_started", { runId: run.id });
    console.log(`Agent run started: ${run.id}`);
    console.log(`Telegram approval gateway: ${telegramConfigStatus()}`);
  });

agent
  .command("stop")
  .description("Mark any in-progress agent runs as completed")
  .action(() => {
    const running = listRunningRuns();
    for (const run of running) {
      finishRun(run.id, "completed", "Stopped via CLI");
      log("agent_stopped", { runId: run.id });
    }
    console.log(`Stopped ${running.length} running run(s).`);
  });

agent
  .command("status")
  .description("Show agent run history and current counts")
  .action(() => {
    const runs = listRuns().slice(0, 5);
    console.log("Recent agent runs:");
    for (const r of runs) console.log(`  ${r.id}  ${r.kind}  ${r.status}  started=${r.startedAt}`);
    console.log("");
    console.log(`Programs: ${listPrograms().length}`);
    console.log(`Tasks: ${listTasks().length} (waiting_approval=${listTasks("waiting_approval").length})`);
    console.log(`Findings: ${listFindings().length}`);
    console.log(`Pending approvals: ${listApprovals("pending").length}`);
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
    for (const f of listFindings(opts.status)) {
      console.log(`${f.id}  [${f.status}/${f.bountyStatus}]  ${f.title}  asset=${f.asset}`);
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

program.parseAsync(process.argv);

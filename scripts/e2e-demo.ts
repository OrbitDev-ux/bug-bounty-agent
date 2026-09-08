#!/usr/bin/env node
/**
 * Section 27 end-to-end safe demo:
 *   Agent Start -> Safari Search -> Open Public Program Page -> Read Public
 *   Text -> Extract Scope -> Create Program -> Create Task -> Telegram
 *   Approval -> Approve -> Task Completed -> Log Result.
 *
 * Uses a real, live public bug bounty policy page and a real local Safari
 * instance via the Safari MCP server (this costs a small amount of Claude
 * API spend — a few $0.01-0.20 calls). If Telegram is configured
 * (TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_IDS in .env), a real approval
 * request is sent and this script waits for a human to tap Approve/Reject
 * in Telegram. If Telegram is NOT configured, the script clearly says so
 * and simulates the approval decision locally so the rest of the state
 * machine (approved -> completed) can still be demonstrated end to end.
 */
import { startRun, finishRun } from "../src/domain/agentRuns.js";
import { listPrograms } from "../src/domain/programs.js";
import { getApproval, listApprovals } from "../src/domain/approvals.js";
import { onboardProgramFromPolicyPage, finalizeApprovedTask } from "../src/agent/orchestrator.js";
import { handleApprovalDecision } from "../src/telegram/approvalHandler.js";
import { telegramConfigStatus } from "../src/config/env.js";
import { log } from "../src/logging/logger.js";

const DEMO_PROGRAM_URL = process.argv[2] ?? "https://bounty.github.com/";
const DEMO_PROGRAM_NAME = process.argv[3] ?? "GitHub Bug Bounty (demo)";
const DEMO_PLATFORM = process.argv[4] ?? "HackerOne";

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function waitForDecision(approvalId: string, timeoutMs: number): Promise<"approved" | "rejected" | "timeout"> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const approval = getApproval(approvalId);
    if (approval?.status === "approved") return "approved";
    if (approval?.status === "rejected") return "rejected";
    await new Promise((r) => setTimeout(r, 3000));
  }
  return "timeout";
}

async function main() {
  section("1. Agent Start");
  const run = startRun("manual");
  log("agent_started", { runId: run.id, demo: true });
  console.log(`Agent run: ${run.id}`);

  const alreadyOnboarded = listPrograms().find((p) => p.url === DEMO_PROGRAM_URL);
  if (alreadyOnboarded) {
    console.log(`Note: "${DEMO_PROGRAM_URL}" was already onboarded as program ${alreadyOnboarded.id} in a previous run.`);
    console.log("Proceeding anyway to demonstrate the full pipeline against a fresh program record.");
  }

  section("2-5. Safari Search / Open Page / Read Text / Extract Scope (via Claude + Safari MCP)");
  console.log(`Reading published policy: ${DEMO_PROGRAM_URL}`);
  const onboard = await onboardProgramFromPolicyPage({
    name: DEMO_PROGRAM_NAME,
    platform: DEMO_PLATFORM,
    policyUrl: DEMO_PROGRAM_URL,
  }).catch((err) => {
    // requestApproval() throws if Telegram isn't configured. We still want
    // to show the rest of the pipeline, so fall back to a config check below.
    return { ok: false as const, program: null, task: null, approvalRequested: false, reason: (err as Error).message, costUsd: 0 };
  });

  if (!onboard.ok) {
    console.error(`FAILED at extraction/scope-check/approval-request: ${onboard.reason}`);
    finishRun(run.id, "failed", onboard.reason);
    process.exitCode = 1;
    return;
  }

  section("6. Create Program");
  console.log(`Program: ${onboard.program!.id} (${onboard.program!.name}), status=${onboard.program!.status}`);
  console.log(`In-scope: ${onboard.program!.policy.inScope.join(", ") || "(none published)"}`);
  console.log(`Automation allowed by policy: ${onboard.program!.policy.automationAllowed}`);

  section("7. Create Task");
  console.log(`Task: ${onboard.task!.id}, type=${onboard.task!.type}, target=${onboard.task!.target}, status=${onboard.task!.status}`);
  console.log(`Scope decision: ${onboard.reason}`);

  if (onboard.task!.status === "blocked") {
    console.log("\nTask is BLOCKED — the confirmed target is not in this program's published scope.");
    console.log("This is the Scope Manager correctly failing closed. Demo ends here (no approval needed for a blocked task).");
    finishRun(run.id, "completed", "Demo ended at scope block (expected safety behavior).");
    return;
  }

  section("8. Telegram Approval");
  const pending = listApprovals("pending").find((a) => a.taskId === onboard.task!.id);
  if (!pending) {
    console.error("Expected a pending approval but found none — aborting.");
    finishRun(run.id, "failed", "No pending approval found after scope approval.");
    process.exitCode = 1;
    return;
  }
  console.log(`Approval request created: ${pending.id}`);
  console.log(`Requested action: ${pending.requestedAction}`);

  const telegramStatus = telegramConfigStatus();
  let decision: "approved" | "rejected" | "timeout";

  if (telegramStatus === "ready") {
    console.log("Telegram is configured — a real approval card was sent. Waiting up to 5 minutes for a human decision...");
    decision = await waitForDecision(pending.id, 5 * 60 * 1000);
  } else {
    console.log(`Telegram is NOT fully configured (status: ${telegramStatus}).`);
    console.log("SIMULATING the human decision locally so the rest of the pipeline can still be demonstrated.");
    console.log("This is NOT a live Telegram round trip — see docs/telegram.md to enable the real thing.");
    const simulatedUserId = "demo-simulated-user";
    // The allowlist is still enforced even in the simulation — temporarily
    // add the simulated id for this process only, exactly as a real deploy
    // would add a real Telegram user id via TELEGRAM_ALLOWED_USER_IDS.
    process.env.TELEGRAM_ALLOWED_USER_IDS = [process.env.TELEGRAM_ALLOWED_USER_IDS, simulatedUserId].filter(Boolean).join(",");
    const result = handleApprovalDecision(pending.id, "approved", simulatedUserId);
    decision = result.ok ? "approved" : "rejected";
  }

  section("9. Approve");
  console.log(`Decision: ${decision}`);
  if (decision !== "approved") {
    finishRun(run.id, "completed", `Demo ended: approval was ${decision}.`);
    return;
  }

  section("10. Task Completed");
  const completed = finalizeApprovedTask(onboard.task!.id, `Demo run: confirmed ${onboard.task!.target} in scope for ${onboard.program!.name}.`);
  console.log(`Task ${completed.id} -> ${completed.status}`);

  section("11. Log Result");
  console.log(`Program:  ${onboard.program!.id}`);
  console.log(`Task:     ${completed.id}`);
  console.log(`Approval: ${pending.id} (${decision})`);
  console.log(`Claude spend this run: $${onboard.costUsd.toFixed(4)}`);

  finishRun(run.id, "completed", `E2E demo completed: program=${onboard.program!.id} task=${completed.id}`);
  log("agent_stopped", { runId: run.id, demo: true });
  console.log("\nDemo complete.");
}

main().catch((err) => {
  console.error("Demo failed with an unexpected error:", err);
  process.exitCode = 1;
});

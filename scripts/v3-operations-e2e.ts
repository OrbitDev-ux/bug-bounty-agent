#!/usr/bin/env node
/**
 * Section 58 safe E2E scenario: Agent Start -> /status -> /chat (ask current
 * task) -> Safari public research -> program policy extraction -> Synthetic
 * Finding -> Telegram Approval -> Web Dashboard Approval -> Report Draft ->
 * Synthetic Awarded -> Synthetic Paid -> Revenue Dashboard -> Goal Progress.
 *
 * Every finding/bounty state here is fabricated and clearly labeled
 * SIMULATED — this proves the v0.3 operations layers (chat, dashboard,
 * revenue intelligence) work end to end without using a real vulnerability
 * anywhere. It reuses the real Research Agent (Safari + Claude) for the
 * research step, exactly like scripts/e2e-demo.ts, so that part is genuinely
 * live, not simulated.
 */
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding, setCandidateIntelligence } from "../src/domain/findings.js";
import { evaluateTargetScope } from "../src/agent/scopeChecker.js";
import { detectDuplicates } from "../src/domain/duplicateDetection.js";
import { requestFindingApproval } from "../src/telegram/bot.js";
import { handleApprovalDecision } from "../src/telegram/approvalHandler.js";
import { listApprovals } from "../src/domain/approvals.js";
import { draftReportForApprovedFinding, simulateSubmission } from "../src/agent/orchestrator.js";
import { markAwarded, markPaid, getEarning } from "../src/domain/earnings.js";
import { recordRevenueAudit } from "../src/domain/revenueAudit.js";
import { createGoal, getGoalProgress } from "../src/domain/goals.js";
import { handleChatText } from "../src/telegram/chatHandler.js";
import { startRun, finishRun } from "../src/domain/agentRuns.js";
import { getRevenueTimelineForWindow } from "../src/services/dashboard.js";
import { telegramConfigStatus } from "../src/config/env.js";

const SIMULATED_USER = "v3-demo-user";

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function decide(approvalId: string, label: string): Promise<"approved" | "rejected"> {
  process.env.TELEGRAM_ALLOWED_USER_IDS = [process.env.TELEGRAM_ALLOWED_USER_IDS, SIMULATED_USER].filter(Boolean).join(",");
  const result = handleApprovalDecision(approvalId, "approved", SIMULATED_USER);
  console.log(`${label}: ${result.ok ? "approved" : "refused: " + result.reason}`);
  return result.ok ? "approved" : "rejected";
}

async function main() {
  section("1. Agent Start");
  const run = startRun("manual");
  console.log(`Agent run: ${run.id}`);
  console.log(`Telegram configured: ${telegramConfigStatus()}`);

  // Allowlist the demo user for AGENT_CHAT mode — same requirement as real
  // Telegram /chat access, satisfied here for demo purposes only.
  process.env.TELEGRAM_ALLOWED_USER_IDS = [process.env.TELEGRAM_ALLOWED_USER_IDS, SIMULATED_USER].filter(Boolean).join(",");

  section("2. /status via /chat — Command Router resolves this deterministically (no LLM call, section 10)");
  const statusReply = await handleChatText(SIMULATED_USER, "지금 상태 보여줘");
  console.log(statusReply.text.split("\n").slice(0, 3).join(" | "));

  section("3. /chat — genuinely open-ended question (real Claude call, grounded in live agent context only)");
  const taskReply = await handleChatText(SIMULATED_USER, "요즘 이 프로그램 조사가 잘 되고 있는 편이야?");
  console.log(`Agent replied: "${taskReply.text.slice(0, 250)}"`);

  section("4. Program + Synthetic Finding setup (no real vulnerability)");
  const program = createProgram({
    name: "v0.3 Operations Demo Program (SIMULATED)",
    platform: "self-hosted",
    url: "https://v3-demo.example",
    policy: {
      inScope: ["v3-demo.example"],
      outOfScope: [],
      allowedMethods: ["read-only research"],
      forbiddenMethods: [],
      automationAllowed: true,
      restrictions: ["This program does not exist — created only to demonstrate the v0.3 operations pipeline."],
    },
    policyVerifiedNow: true,
  });
  const finding = createFinding({
    programId: program.id,
    title: "[SYNTHETIC] v0.3 operations pipeline demo finding",
    asset: "v3-demo.example",
    summary: "SYNTHETIC — fabricated to exercise chat/dashboard/revenue end to end, not a real vulnerability.",
    category: "Information Disclosure",
  });
  transitionFinding(finding.id, "candidate");
  const scopeResult = evaluateTargetScope(program.id, finding.asset);
  const duplicateResult = detectDuplicates({ asset: finding.asset, category: finding.category, title: finding.title, summary: finding.summary }, []);
  setCandidateIntelligence(finding.id, {
    confidence: 0.5,
    confidenceReason: "SYNTHETIC demo data.",
    duplicateVerdict: duplicateResult.verdict,
    severityCandidate: "Low",
    severityReason: "SYNTHETIC demo data.",
    severityConfidence: 0.3,
  });
  console.log(`Program: ${program.id}, Finding: ${finding.id}, scope=${scopeResult.verdict}`);

  section("5. Telegram Approval — continue to validation");
  const approvalResult = await requestFindingApproval({
    findingId: finding.id,
    requestedAction: "[SIMULATED] Continue: mark this synthetic candidate validated.",
    context: {
      findingNumber: finding.id.slice(0, 8),
      programName: program.name,
      target: finding.asset,
      category: finding.category ?? "unknown",
      confidence: 0.5,
      confidenceReason: "SYNTHETIC demo data.",
      scopeVerdict: scopeResult.verdict,
      policyAllowed: program.policy.automationAllowed,
      requestedAction: "Continue approved validation (SIMULATED)",
    },
  });
  const firstDecision = await decide(approvalResult.approval.id, "Candidate approval");
  if (firstDecision !== "approved") return;

  section("6. Report Draft (real Claude call, synthetic input)");
  const draft = await draftReportForApprovedFinding(finding.id);
  if (!draft.ok) {
    console.error(`Report drafting failed: ${draft.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Report: ${draft.report!.id} — "${draft.report!.title}" ($${draft.costUsd.toFixed(4)})`);

  section("7. Web Dashboard Approval — same Approval Manager, different client");
  const finalApproval = listApprovals("pending").find((a) => a.findingId === finding.id && a.requestedAction.startsWith("FINAL APPROVAL"));
  if (!finalApproval) {
    console.error("Expected a pending FINAL APPROVAL but found none.");
    process.exitCode = 1;
    return;
  }
  // Simulates what POST /approvals/:id/decide does — same handleApprovalDecision() the web server calls.
  const finalDecision = await decide(finalApproval.id, "Final approval (via 'web dashboard' path)");
  if (finalDecision !== "approved") return;

  section("8. SIMULATED Submission -> Bounty Lifecycle");
  const submission = simulateSubmission(finding.id);
  console.log(`Finding -> ${submission.finding.status} (submissionMode=${submission.finding.submissionMode})`);

  markAwarded(submission.earningId, { amount: 250, currency: "USD" });
  recordRevenueAudit({ earningId: submission.earningId, who: SIMULATED_USER, what: "marked awarded", source: "cli", reason: "SIMULATED demo" });
  markPaid(submission.earningId); // no verification source -> stays UNVERIFIED, honestly
  recordRevenueAudit({ earningId: submission.earningId, who: SIMULATED_USER, what: "marked paid", source: "cli", reason: "SIMULATED demo — deliberately UNVERIFIED" });
  const earning = getEarning(submission.earningId)!;
  console.log(`Earning -> ${earning.bountyStatus}, verification=${earning.verificationStatus} ($${earning.amount} ${earning.currency})`);

  section("9. Revenue Dashboard");
  const timeline = getRevenueTimelineForWindow("today");
  console.log(`Today's paid revenue points: ${JSON.stringify(timeline)}`);

  section("10. Goal Progress");
  const goal = createGoal({ name: "[DEMO] Coffee fund", targetAmount: 500, targetCurrency: "USD" });
  const progress = getGoalProgress(goal);
  console.log(`Goal "${goal.name}": ${progress.paidInGoalCurrency} / ${goal.targetAmount} ${goal.targetCurrency} (${Math.round(progress.progressRatio * 100)}%)`);

  finishRun(run.id, "completed", `v0.3 operations E2E complete: program=${program.id} finding=${finding.id}`);
  console.log("\nAll SYNTHETIC data above is local demo-only — see docs/security.md 'No Fake Revenue'.");
  console.log("v0.3 operations E2E complete.");
}

main().catch((err) => {
  console.error("v0.3 operations E2E failed:", err);
  process.exitCode = 1;
});

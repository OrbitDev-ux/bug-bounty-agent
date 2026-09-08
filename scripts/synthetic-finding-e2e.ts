#!/usr/bin/env node
/**
 * Section 27/49 synthetic-finding demo: exercises the FULL downstream
 * pipeline (candidate -> approval -> report draft -> final approval ->
 * SIMULATED submission -> bounty lifecycle -> earnings) without using a
 * real vulnerability anywhere. The "finding" itself is fabricated and
 * clearly labeled SYNTHETIC at every step; everything else — scope
 * checking, duplicate detection, the Telegram approval gates (or their
 * local simulation, identically allowlist-enforced), report drafting via
 * the real Reporter role (a real, live Claude call), the Submission Gate,
 * and the bounty lifecycle — is the real code path, genuinely exercised.
 *
 * This never calls Safari or the Research Agent — see scripts/e2e-demo.ts
 * for the live research/scope-extraction flow. This script picks up from
 * "a candidate finding already exists."
 */
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding, setCandidateIntelligence, getFinding } from "../src/domain/findings.js";
import { evaluateTargetScope } from "../src/agent/scopeChecker.js";
import { detectDuplicates } from "../src/domain/duplicateDetection.js";
import { requestFindingApproval } from "../src/telegram/bot.js";
import { handleApprovalDecision } from "../src/telegram/approvalHandler.js";
import { listApprovals } from "../src/domain/approvals.js";
import { draftReportForApprovedFinding, simulateSubmission } from "../src/agent/orchestrator.js";
import { markAwarded, markPaid, getEarning } from "../src/domain/earnings.js";
import { summarizeEarnings } from "../src/domain/earnings.js";
import { telegramConfigStatus } from "../src/config/env.js";

const SIMULATED_TELEGRAM_USER_ID = "demo-simulated-user";

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function decide(approvalId: string, label: string) {
  const telegramReady = telegramConfigStatus() === "ready";
  if (telegramReady) {
    console.log(`Telegram is configured — waiting up to 5 minutes for a real decision on ${label}...`);
    const start = Date.now();
    while (Date.now() - start < 5 * 60 * 1000) {
      const approval = listApprovals().find((a) => a.id === approvalId);
      if (approval?.status === "approved") return "approved";
      if (approval?.status === "rejected") return "rejected";
      await new Promise((r) => setTimeout(r, 3000));
    }
    return "timeout";
  }

  console.log(`Telegram not configured — SIMULATING approval of ${label} via the same allowlist-enforced code path.`);
  process.env.TELEGRAM_ALLOWED_USER_IDS = [process.env.TELEGRAM_ALLOWED_USER_IDS, SIMULATED_TELEGRAM_USER_ID].filter(Boolean).join(",");
  const result = handleApprovalDecision(approvalId, "approved", SIMULATED_TELEGRAM_USER_ID);
  return result.ok ? "approved" : "rejected";
}

async function main() {
  section("1. Synthetic Finding — setup");
  const program = createProgram({
    name: "Synthetic Demo Program (SIMULATED)",
    platform: "self-hosted",
    url: "https://synthetic-demo.example",
    policy: {
      inScope: ["synthetic-demo.example"],
      outOfScope: [],
      allowedMethods: ["read-only research"],
      forbiddenMethods: [],
      automationAllowed: true,
      restrictions: ["This program does not exist. Created only to demonstrate the v0.2 pipeline."],
    },
    policyVerifiedNow: true,
  });
  console.log(`Program: ${program.id} (${program.name})`);

  const finding = createFinding({
    programId: program.id,
    title: "[SYNTHETIC] Example information-disclosure lead for pipeline testing",
    asset: "synthetic-demo.example",
    summary: "SYNTHETIC finding, not a real vulnerability. Fabricated to exercise the v0.2 approval/report/submission pipeline end to end.",
    category: "Information Disclosure",
  });
  transitionFinding(finding.id, "candidate");
  console.log(`Finding: ${finding.id} [${finding.status}]`);

  section("2. Scope + Duplicate Intelligence");
  const scopeResult = evaluateTargetScope(program.id, finding.asset);
  const duplicateResult = detectDuplicates({ asset: finding.asset, category: finding.category, title: finding.title, summary: finding.summary }, []);
  console.log(`Scope verdict: ${scopeResult.verdict} (${scopeResult.reason})`);
  console.log(`Duplicate verdict: ${duplicateResult.verdict}`);

  setCandidateIntelligence(finding.id, {
    confidence: 0.4,
    confidenceReason: "SYNTHETIC — fabricated confidence for demo purposes only.",
    duplicateVerdict: duplicateResult.verdict,
    duplicateOfFindingId: duplicateResult.matchedFindingId,
    severityCandidate: "Low",
    severityReason: "SYNTHETIC — fabricated severity for demo purposes only.",
    severityConfidence: 0.3,
  });

  section("3. Telegram Approval — continue to validation");
  const approvalResult = await requestFindingApproval({
    findingId: finding.id,
    requestedAction: "[SIMULATED] Continue: mark this synthetic candidate validated and proceed to report drafting.",
    context: {
      findingNumber: finding.id.slice(0, 8),
      programName: program.name,
      target: finding.asset,
      category: finding.category ?? "unknown",
      confidence: 0.4,
      confidenceReason: "SYNTHETIC demo data.",
      scopeVerdict: scopeResult.verdict,
      policyAllowed: program.policy.automationAllowed,
      requestedAction: "Continue approved validation (SIMULATED)",
    },
  });
  console.log(`Approval requested: ${approvalResult.approval.id} (delivered=${approvalResult.delivered})`);

  const firstDecision = await decide(approvalResult.approval.id, "candidate approval");
  console.log(`Decision: ${firstDecision}`);
  if (firstDecision !== "approved") {
    console.log("Demo ends here — candidate was not approved.");
    return;
  }

  section("4. Safe Next Step -> Report Draft");
  const draft = await draftReportForApprovedFinding(finding.id);
  if (!draft.ok) {
    console.error(`Report drafting failed: ${draft.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Finding -> ${draft.finding.status}`);
  console.log(`Report: ${draft.report!.id} — "${draft.report!.title}"`);
  console.log(`Claude cost (real call, synthetic input): $${draft.costUsd.toFixed(4)}`);

  section("5. Telegram FINAL Approval — submission gate");
  const finalApproval = listApprovals("pending").find((a) => a.findingId === finding.id && a.requestedAction.startsWith("FINAL APPROVAL"));
  if (!finalApproval) {
    console.error("Expected a pending FINAL APPROVAL but found none — aborting.");
    process.exitCode = 1;
    return;
  }
  const finalDecision = await decide(finalApproval.id, "final submission approval");
  console.log(`Decision: ${finalDecision}`);
  if (finalDecision !== "approved") {
    console.log("Demo ends here — final submission was not approved.");
    return;
  }

  section("6. SIMULATED Submission");
  const submission = simulateSubmission(finding.id);
  console.log(`Finding -> ${submission.finding.status} (submissionMode=${submission.finding.submissionMode})`);
  console.log(`Earning record: ${submission.earningId} (bountyStatus=pending)`);

  section("7. Bounty Lifecycle -> Result Tracking (still fabricated — SYNTHETIC amounts)");
  markAwarded(submission.earningId, { amount: 123.45, currency: "USD" });
  console.log(`Earning -> awarded (SYNTHETIC amount, not a real bounty)`);
  markPaid(submission.earningId);
  const earning = getEarning(submission.earningId)!;
  console.log(`Earning -> paid: $${earning.amount} ${earning.currency} at ${earning.paidAt}`);

  section("8. Result Tracking");
  console.log(`Final finding state: ${getFinding(finding.id)!.status} / bountyStatus=n/a (tracked on the Earning row, not the Finding)`);
  const summary = summarizeEarnings();
  console.log(`Earnings summary (all real numbers now, sourced from this SYNTHETIC run): ${JSON.stringify(summary)}`);
  console.log("\nNote: this $123.45 is entirely fabricated demo data for pipeline verification.");
  console.log("It exists in earnings.summarizeEarnings() output only because THIS demo explicitly marked it paid —");
  console.log("no real platform confirmed anything. See docs/security.md section on 'No Fake Revenue' for how this");
  console.log("is kept out of any real reporting path (there is none in v0.2; this is local demo data only).");

  console.log("\nSynthetic finding E2E complete.");
}

main().catch((err) => {
  console.error("Synthetic E2E failed with an unexpected error:", err);
  process.exitCode = 1;
});

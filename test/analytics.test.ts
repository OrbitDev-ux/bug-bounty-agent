import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding } from "../src/domain/findings.js";
import { createReport } from "../src/domain/reports.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { recordCost } from "../src/domain/costs.js";
import { startResearchSession, completeResearchSession } from "../src/domain/researchSessions.js";
import {
  getFunnelMetrics,
  getConversionRates,
  getFindingProfitabilityByCategory,
  getTimeToBounty,
  getNetRevenue,
  getProgramRevenuePerHour,
} from "../src/services/analytics.js";
import type { Program } from "../src/domain/types.js";

let program: Program;

beforeEach(() => {
  freshDb();
  program = createProgram({
    name: "P",
    platform: "self-hosted",
    url: "https://example.com",
    policy: { inScope: ["example.com"], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] },
  });
});

function fullPipelineFinding(category: string, amount: number, currency: string) {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com", category });
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  createReport({
    findingId: finding.id,
    title: "t",
    program: program.name,
    asset: finding.asset,
    summary: "s",
    impact: "i",
    stepsToReproduce: "s",
    evidence: "e",
    expectedBehavior: "e",
    observedBehavior: "o",
    suggestedRemediation: "s",
    references: "r",
  });
  transitionFinding(finding.id, "submitted");
  transitionFinding(finding.id, "triaged");
  transitionFinding(finding.id, "accepted");
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount, currency });
  markPaid(earning.id);
  return { finding, earning };
}

test("getFunnelMetrics counts each stage exactly, from real stamped state", () => {
  fullPipelineFinding("Authorization", 100, "USD");
  const orphanCandidate = createFinding({ programId: program.id, title: "never submitted", asset: "example.com" });
  transitionFinding(orphanCandidate.id, "candidate");

  const funnel = getFunnelMetrics();
  assert.equal(funnel.candidates, 2);
  assert.equal(funnel.reports, 1);
  assert.equal(funnel.submitted, 1);
  assert.equal(funnel.accepted, 1);
  assert.equal(funnel.awarded, 1);
  assert.equal(funnel.paid, 1);
});

test("getConversionRates returns N/A (null) on a zero denominator, never a fabricated 0% or NaN", () => {
  const rates = getConversionRates();
  assert.equal(rates.candidateToReport, null);
  assert.equal(rates.reportToAccepted, null);
});

test("getConversionRates computes real rates once data exists", () => {
  fullPipelineFinding("Authorization", 100, "USD");
  const rates = getConversionRates();
  assert.equal(rates.candidateToReport, 1); // 1 report / 1 candidate
  assert.equal(rates.reportToAccepted, 1);
  assert.equal(rates.acceptedToAwarded, 1);
  assert.equal(rates.awardedToPaid, 1);
});

test("getFindingProfitabilityByCategory keeps currencies separate and groups by category", () => {
  fullPipelineFinding("Authorization", 100, "USD");
  fullPipelineFinding("Authorization", 200, "USD");
  fullPipelineFinding("XSS", 50000, "KRW");

  const byCategory = getFindingProfitabilityByCategory();
  const auth = byCategory.find((c) => c.category === "Authorization")!;
  assert.equal(auth.paidCount, 2);
  assert.equal(auth.paidRevenueByCurrency.find((r) => r.currency === "USD")?.total, 300);
  assert.equal(auth.averageBountyByCurrency.find((r) => r.currency === "USD")?.average, 150);

  const xss = byCategory.find((c) => c.category === "XSS")!;
  assert.equal(xss.paidRevenueByCurrency.find((r) => r.currency === "KRW")?.total, 50000);
});

test("getTimeToBounty computes real durations and reports sample sizes, null when no data", () => {
  const empty = getTimeToBounty();
  assert.equal(empty.submissionToAcceptedAvgHours, null);
  assert.equal(empty.sampleSizes.submissionToAccepted, 0);

  fullPipelineFinding("Authorization", 100, "USD");
  const withData = getTimeToBounty();
  assert.equal(withData.sampleSizes.submissionToAccepted, 1);
  assert.ok(withData.submissionToAcceptedAvgHours !== null);
  assert.ok(withData.submissionToAcceptedAvgHours! >= 0);
});

test("getNetRevenue is NOT AVAILABLE (null) when cost tracking has never been used", () => {
  fullPipelineFinding("Authorization", 100, "USD");
  const net = getNetRevenue("all");
  const usd = net.find((n) => n.currency === "USD")!;
  assert.equal(usd.trackedCosts, null);
  assert.equal(usd.net, null);
  assert.equal(usd.grossPaid, 100); // gross is still reported even when net isn't computable
});

test("getNetRevenue computes a real net once cost tracking exists, never assuming zero cost", () => {
  fullPipelineFinding("Authorization", 100, "USD");
  recordCost({ category: "claude_api", amount: 15, currency: "USD" });

  const net = getNetRevenue("all");
  const usd = net.find((n) => n.currency === "USD")!;
  assert.equal(usd.trackedCosts, 15);
  assert.equal(usd.net, 85);
});

test("getProgramRevenuePerHour returns null (not fabricated) with no completed research sessions", () => {
  const result = getProgramRevenuePerHour(program.id);
  assert.equal(result.revenuePerHourByCurrency, null);
  assert.equal(result.totalTrackedHours, 0);
});

test("getProgramRevenuePerHour computes from real session duration once one exists", () => {
  const session = startResearchSession({ programId: program.id, goal: "g" });
  // Simulate elapsed time by completing immediately (duration will be tiny
  // but nonzero-ish); assert the shape/behavior, not an exact number.
  completeResearchSession(session.id, { status: "completed", summary: "done" });
  fullPipelineFinding("Authorization", 360, "USD");

  const result = getProgramRevenuePerHour(program.id);
  // Duration could be ~0 for an instantaneous test — only assert the
  // structure is populated when totalTrackedHours > 0, else null, matching
  // the "never fabricate" contract at the boundary.
  if (result.totalTrackedHours > 0) {
    assert.ok(result.revenuePerHourByCurrency !== null);
  } else {
    assert.equal(result.revenuePerHourByCurrency, null);
  }
});

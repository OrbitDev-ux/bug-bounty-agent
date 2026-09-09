import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding } from "../src/domain/findings.js";
import { createReport } from "../src/domain/reports.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { buildWeeklySummary, formatWeeklySummaryMessage, buildMonthlySummary, formatMonthlySummaryMessage } from "../src/telegram/dailySummary.js";
import type { Program } from "../src/domain/types.js";

let program: Program;

beforeEach(() => {
  freshDb();
  program = createProgram({
    name: "Test Program",
    platform: "self-hosted",
    url: "https://example.com",
    policy: { inScope: ["example.com"], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] },
  });
});

function fullPipeline(amount: number, currency: string) {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com", category: "Authorization" });
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
}

test("buildWeeklySummary reflects real data and identifies the top program/category", () => {
  fullPipeline(500, "USD");
  const summary = buildWeeklySummary();
  assert.equal(summary.reports, 1);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.topProgram, "Test Program");
  assert.equal(summary.topCategory, "Authorization");
  assert.equal(summary.paidByCurrency.find((b) => b.currency === "USD")?.total, 500);
});

test("formatWeeklySummaryMessage never crashes on empty data and shows n/a, not fabricated data", () => {
  const text = formatWeeklySummaryMessage(buildWeeklySummary());
  assert.match(text, /Top Program:\nn\/a/);
  assert.match(text, /Top Finding Category:\nn\/a/);
});

test("buildMonthlySummary computes a real per-currency average paid bounty", () => {
  fullPipeline(100, "USD");
  fullPipeline(300, "USD");
  const summary = buildMonthlySummary();
  const usdAvg = summary.averagePaidBountyByCurrency.find((b) => b.currency === "USD");
  assert.equal(usdAvg?.average, 200); // (100+300)/2
  assert.equal(summary.paidCount, 2);
});

test("formatMonthlySummaryMessage shows n/a for average bounty when there's no paid data", () => {
  const text = formatMonthlySummaryMessage(buildMonthlySummary());
  assert.match(text, /Average Paid Bounty:\nn\/a/);
});

test("buildMonthlySummary never mixes currencies in the awarded/pending/paid breakdowns", () => {
  fullPipeline(100, "USD");
  const finding = createFinding({ programId: program.id, title: "f2", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 50000, currency: "KRW" }); // awarded, not paid

  const summary = buildMonthlySummary();
  assert.equal(summary.paidByCurrency.find((b) => b.currency === "KRW")?.total ?? 0, 0);
  assert.equal(summary.awardedByCurrency.find((b) => b.currency === "KRW")?.total, 50000);
});

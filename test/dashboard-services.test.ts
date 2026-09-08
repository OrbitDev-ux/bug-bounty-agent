import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding, setCandidateIntelligence } from "../src/domain/findings.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { getProgramStats, getFindingStats, getRevenueTimeline } from "../src/services/dashboard.js";
import { getMetrics, getROI } from "../src/services/metrics.js";
import { buildDailySummary } from "../src/telegram/dailySummary.js";
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

test("getProgramStats counts by status", () => {
  const stats = getProgramStats();
  assert.equal(stats.total, 1);
  assert.equal(stats.active, 1);
});

test("getFindingStats counts candidates and likely duplicates", () => {
  const f1 = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  transitionFinding(f1.id, "candidate");
  const f2 = createFinding({ programId: program.id, title: "B", asset: "example.com" });
  transitionFinding(f2.id, "candidate");
  setCandidateIntelligence(f2.id, { duplicateVerdict: "LIKELY_DUPLICATE", duplicateOfFindingId: f1.id });

  const stats = getFindingStats();
  assert.equal(stats.total, 2);
  assert.equal(stats.candidatesAwaitingReview, 2);
  assert.equal(stats.likelyDuplicates, 1);
});

test("getRevenueTimeline only includes paid earnings, never awarded/pending (section 45)", () => {
  const f1 = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  const e1 = createEarning({ findingId: f1.id, programId: program.id });
  markAwarded(e1.id, { amount: 500, currency: "USD" }); // awarded but not paid

  const f2 = createFinding({ programId: program.id, title: "B", asset: "example.com" });
  const e2 = createEarning({ findingId: f2.id, programId: program.id });
  markAwarded(e2.id, { amount: 250, currency: "USD" });
  markPaid(e2.id);

  const timeline = getRevenueTimeline();
  const total = timeline.reduce((sum, p) => sum + p.amount, 0);
  assert.equal(total, 250); // only the paid one
});

test("getMetrics: revenue is paid-only and candidate count is tracked separately from revenue", () => {
  const f1 = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  transitionFinding(f1.id, "candidate");
  const f2 = createFinding({ programId: program.id, title: "B", asset: "example.com" });
  transitionFinding(f2.id, "candidate");

  const metrics = getMetrics();
  assert.equal(metrics.candidateFindings, 2);
  assert.equal(metrics.revenue, 0); // no paid earnings yet — candidates alone must not imply revenue
});

test("getROI returns null revenuePerHour when there is no tracked agent-run time", () => {
  const roi = getROI();
  assert.equal(roi.revenuePerHour, null);
  assert.equal(roi.totalTrackedHours, 0);
});

test("buildDailySummary never reports simulated/pending amounts as bounties paid", () => {
  const f1 = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  const e1 = createEarning({ findingId: f1.id, programId: program.id });
  markAwarded(e1.id, { amount: 1000, currency: "USD" }); // not paid

  const summary = buildDailySummary();
  assert.equal(summary.bountiesPaidToday, 0);
});

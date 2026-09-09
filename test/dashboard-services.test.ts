import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding, setCandidateIntelligence } from "../src/domain/findings.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { getProgramStats, getFindingStats, getRevenueTimeline, getProgramCandidates, getProgramComparison, getEnrollmentStatus, getSelectedProgram } from "../src/services/dashboard.js";
import { getMetrics, getROI } from "../src/services/metrics.js";
import { buildDailySummary } from "../src/telegram/dailySummary.js";
import { createCandidate, recordResearch, selectCandidate } from "../src/domain/programCandidates.js";
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

// --- v0.3.2: Program Candidate Discovery dashboard/Telegram single-source-of-truth ---

test("getProgramCandidates returns candidates, optionally filtered by stage — never the live `programs` table", () => {
  createCandidate({ name: "C1", platform: "self-hosted", officialUrl: "https://c1.example.com" });
  const c2 = createCandidate({ name: "C2", platform: "self-hosted", officialUrl: "https://c2.example.com" });
  recordResearch(c2.id, { scopeClarity: "HIGH" });

  assert.equal(getProgramCandidates().length, 2);
  assert.equal(getProgramCandidates("discovered").length, 1);
  assert.equal(getProgramCandidates("candidate").length, 1);
});

test("getProgramComparison ranks candidates and matches domain compareCandidates()", () => {
  const c1 = createCandidate({ name: "C1", platform: "self-hosted", officialUrl: "https://c1.example.com" });
  recordResearch(c1.id, { scopeClarity: "HIGH", policyClarity: "HIGH", automationPolicy: "allowed", publicOrPrivate: "public" });
  const comparison = getProgramComparison();
  assert.equal(comparison.candidateCount, 1);
  assert.equal(comparison.ranked[0]!.candidate.id, c1.id);
});

test("getEnrollmentStatus reports Enrollment/Authorization/Live Testing exactly like the section-21 Telegram shape", () => {
  const c = createCandidate({ name: "C", platform: "self-hosted", officialUrl: "https://c.example.com" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  selectCandidate(c.id, "op");

  const status = getEnrollmentStatus(c.id)!;
  assert.equal(status.enrollmentComplete, false); // checklist just generated, nothing checked yet
  assert.equal(status.authorizationConfirmed, false);
  assert.equal(status.liveTestingBlocked, true);
});

test("getEnrollmentStatus returns null for an unknown candidate id", () => {
  assert.equal(getEnrollmentStatus("nonexistent"), null);
});

test("getSelectedProgram returns null until a candidate has actually been selected", () => {
  assert.equal(getSelectedProgram(), null);
  const c = createCandidate({ name: "C", platform: "self-hosted", officialUrl: "https://c.example.com" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  assert.equal(getSelectedProgram(), null, "researched but not yet selected");
  selectCandidate(c.id, "op");
  assert.equal(getSelectedProgram()!.id, c.id);
});

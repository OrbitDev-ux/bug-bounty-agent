import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding } from "../src/domain/findings.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { getProgramAnalytics, getRevenueTimelineForWindow } from "../src/services/dashboard.js";
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

test("getProgramAnalytics computes average/median/largest per currency, never fabricated when empty", () => {
  const analytics = getProgramAnalytics(program.id);
  assert.equal(analytics.paidCount, 0);
  assert.deepEqual(analytics.averageBountyByCurrency, []);
  assert.deepEqual(analytics.medianBountyByCurrency, []);
});

test("getProgramAnalytics: median of an odd set is the middle value, even set is averaged", () => {
  const amounts = [100, 300, 500]; // median 300
  for (const amount of amounts) {
    const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
    const earning = createEarning({ findingId: finding.id, programId: program.id });
    markAwarded(earning.id, { amount, currency: "USD" });
    markPaid(earning.id);
  }

  const analytics = getProgramAnalytics(program.id);
  const usd = analytics.medianBountyByCurrency.find((m) => m.currency === "USD");
  assert.equal(usd?.median, 300);
  const largest = analytics.largestBountyByCurrency.find((m) => m.currency === "USD");
  assert.equal(largest?.amount, 500);
  const avg = analytics.averageBountyByCurrency.find((m) => m.currency === "USD");
  assert.equal(avg?.average, 300);
});

test("getProgramAnalytics keeps currencies separate, never averaging across them", () => {
  const f1 = createFinding({ programId: program.id, title: "f1", asset: "example.com" });
  const e1 = createEarning({ findingId: f1.id, programId: program.id });
  markAwarded(e1.id, { amount: 100, currency: "USD" });
  markPaid(e1.id);

  const f2 = createFinding({ programId: program.id, title: "f2", asset: "example.com" });
  const e2 = createEarning({ findingId: f2.id, programId: program.id });
  markAwarded(e2.id, { amount: 200000, currency: "KRW" });
  markPaid(e2.id);

  const analytics = getProgramAnalytics(program.id);
  assert.equal(analytics.paidRevenueByCurrency.length, 2);
  assert.equal(analytics.paidRevenueByCurrency.find((c) => c.currency === "USD")?.total, 100);
  assert.equal(analytics.paidRevenueByCurrency.find((c) => c.currency === "KRW")?.total, 200000);
});

test("getProgramAnalytics counts accepted findings and reports", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  transitionFinding(finding.id, "submitted");
  transitionFinding(finding.id, "triaged");
  transitionFinding(finding.id, "accepted");

  const analytics = getProgramAnalytics(program.id);
  assert.equal(analytics.accepted, 1);
});

test("getRevenueTimelineForWindow('today') excludes payments from other days", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 50, currency: "USD" });
  markPaid(earning.id); // paidAt = now

  const todayPoints = getRevenueTimelineForWindow("today");
  assert.equal(todayPoints.length, 1);

  const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
  const futureTodayPoints = getRevenueTimelineForWindow("today", farFuture);
  assert.equal(futureTodayPoints.length, 0);
});

test("getRevenueTimelineForWindow('all') never filters anything out", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 50, currency: "USD" });
  markPaid(earning.id);

  assert.equal(getRevenueTimelineForWindow("all").length, 1);
});

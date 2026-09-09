import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding } from "../src/domain/findings.js";
import { createEarning, markAwarded, markPaid, summarizeEarningsByCurrency, recordExchangeRate } from "../src/domain/earnings.js";
import { recordCost, listCosts, summarizeCostsByCurrency } from "../src/domain/costs.js";
import { createGoal, listGoals, archiveGoal, getGoalProgress } from "../src/domain/goals.js";
import { recordRevenueAudit, listRevenueAuditForEarning } from "../src/domain/revenueAudit.js";
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

test("earnings never mix currencies into one total (section 23)", () => {
  const f1 = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  const e1 = createEarning({ findingId: f1.id, programId: program.id });
  markAwarded(e1.id, { amount: 500, currency: "USD" });
  markPaid(e1.id);

  const f2 = createFinding({ programId: program.id, title: "B", asset: "example.com" });
  const e2 = createEarning({ findingId: f2.id, programId: program.id });
  markAwarded(e2.id, { amount: 300000, currency: "KRW" });
  markPaid(e2.id);

  const buckets = summarizeEarningsByCurrency();
  const usd = buckets.find((b) => b.currency === "USD");
  const krw = buckets.find((b) => b.currency === "KRW");
  assert.equal(usd?.paid, 500);
  assert.equal(krw?.paid, 300000);
});

test("markPaid without a verification source stays UNVERIFIED (section 24-25)", () => {
  const finding = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 100, currency: "USD" });
  const paid = markPaid(earning.id);
  assert.equal(paid.verificationStatus, "UNVERIFIED");
});

test("markPaid with an explicit verification source becomes VERIFIED", () => {
  const finding = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 100, currency: "USD" });
  const paid = markPaid(earning.id, "manually confirmed on HackerOne dashboard");
  assert.equal(paid.verificationStatus, "VERIFIED");
  assert.equal(paid.verificationSource, "manually confirmed on HackerOne dashboard");
});

test("recordExchangeRate never overwrites the original amount/currency", () => {
  const finding = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 100, currency: "USD" });
  const converted = recordExchangeRate(earning.id, 1350.5, "manual");
  assert.equal(converted.amount, 100);
  assert.equal(converted.currency, "USD");
  assert.equal(converted.exchangeRate, 1350.5);
  assert.equal(converted.rateSource, "manual");
});

test("costs.recordCost is a real measured entry, currency-bucketed separately", () => {
  recordCost({ category: "claude_api", amount: 0.42, note: "research session" });
  recordCost({ category: "claude_api", amount: 0.1 });
  recordCost({ category: "hosting", amount: 5, currency: "USD" });

  assert.equal(listCosts().length, 3);
  const buckets = summarizeCostsByCurrency();
  const usd = buckets.find((b) => b.currency === "USD")!;
  assert.equal(Math.round(usd.total * 100) / 100, 5.52);
  assert.equal(Math.round((usd.byCategory.claude_api ?? 0) * 100) / 100, 0.52);
});

test("goal progress only counts PAID earnings in the goal's exact currency", () => {
  const goal = createGoal({ name: "MacBook Pro", targetAmount: 2_500_000, targetCurrency: "KRW" });

  const f1 = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  const e1 = createEarning({ findingId: f1.id, programId: program.id });
  markAwarded(e1.id, { amount: 500, currency: "USD" }); // wrong currency, awarded not paid
  markPaid(e1.id);

  let progress = getGoalProgress(goal);
  assert.equal(progress.paidInGoalCurrency, 0); // USD paid doesn't count toward a KRW goal

  const f2 = createFinding({ programId: program.id, title: "B", asset: "example.com" });
  const e2 = createEarning({ findingId: f2.id, programId: program.id });
  markAwarded(e2.id, { amount: 625_000, currency: "KRW" });
  markPaid(e2.id);

  progress = getGoalProgress(goal);
  assert.equal(progress.paidInGoalCurrency, 625_000);
  assert.equal(progress.progressRatio, 0.25);
});

test("archived goals are excluded from listGoals() by default", () => {
  const goal = createGoal({ name: "Temp", targetAmount: 100, targetCurrency: "USD" });
  assert.equal(listGoals().length, 1);
  archiveGoal(goal.id);
  assert.equal(listGoals().length, 0);
  assert.equal(listGoals(true).length, 1);
});

test("revenue audit records who/what/when/source/previous/new/reason (section 39)", () => {
  const finding = createFinding({ programId: program.id, title: "A", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 100, currency: "USD" });

  recordRevenueAudit({
    earningId: earning.id,
    who: "42",
    what: "marked awarded",
    source: "telegram",
    previousValue: { bountyStatus: "pending" },
    newValue: { bountyStatus: "awarded", amount: 100, currency: "USD" },
    reason: "Program confirmed award via email",
  });

  const entries = listRevenueAuditForEarning(earning.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.who, "42");
  assert.equal(entries[0]?.source, "telegram");
  assert.match(entries[0]?.newValue ?? "", /awarded/);
});

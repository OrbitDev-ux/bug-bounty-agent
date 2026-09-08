import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding } from "../src/domain/findings.js";
import { createEarning, markAwarded, markPaid, summarizeEarnings } from "../src/domain/earnings.js";
import type { Program } from "../src/domain/types.js";

let program: Program;

beforeEach(() => {
  freshDb();
  program = createProgram({
    name: "Test Program",
    platform: "self-hosted",
    url: "https://example.com",
    policy: {
      inScope: ["example.com"],
      outOfScope: [],
      allowedMethods: [],
      forbiddenMethods: [],
      automationAllowed: true,
      restrictions: [],
    },
  });
});

test("awarded-but-unpaid earnings do not count toward allTime/paid", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 500, currency: "USD" });

  const summary = summarizeEarnings(new Date("2026-06-15T12:00:00.000Z"));
  assert.equal(summary.allTime, 0);
  assert.equal(summary.paid, 0);
  assert.equal(summary.pending, 500);
});

test("paid earnings count toward allTime/paid and pending drops", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 500, currency: "USD" });
  const paid = markPaid(earning.id);
  assert.equal(paid.bountyStatus, "paid");

  const summary = summarizeEarnings(new Date());
  assert.equal(summary.allTime, 500);
  assert.equal(summary.paid, 500);
  assert.equal(summary.pending, 0);
});

test("today/thisMonth only include payments within the respective window", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 100, currency: "USD" });
  markPaid(earning.id); // paidAt = now (real time)

  const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400); // > 1 year later
  const summary = summarizeEarnings(farFuture);
  assert.equal(summary.today, 0);
  assert.equal(summary.thisMonth, 0);
  assert.equal(summary.allTime, 100); // all-time is not date-windowed
});

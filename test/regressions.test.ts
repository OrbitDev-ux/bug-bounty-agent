import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding } from "../src/domain/findings.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { listFindings } from "../src/domain/findings.js";
import { getDb } from "../src/db/client.js";
import { getMetrics } from "../src/services/metrics.js";
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

/**
 * Regression: listFindings() (and every other created_at-DESC listing)
 * used to order ties (identical created_at, e.g. several candidates
 * created within the same millisecond by one research session)
 * unpredictably, since SQLite gives no ordering guarantee among tied rows
 * without a secondary key. Fixed by adding `, rowid DESC` as a tiebreaker,
 * which reflects true insertion order. This test forces several findings
 * to share an identical created_at directly at the DB layer (bypassing the
 * real clock) to make sure the tiebreaker — not luck — is what's ordering them.
 */
test("listFindings() is deterministically most-recent-first even when created_at ties (rowid tiebreaker)", () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const f = createFinding({ programId: program.id, title: `f${i}`, asset: "example.com" });
    ids.push(f.id);
  }

  // Force every row to share the exact same created_at, simulating a
  // same-millisecond burst of creations.
  const db = getDb();
  const tie = "2026-01-01T00:00:00.000Z";
  for (const id of ids) {
    db.prepare("UPDATE findings SET created_at = ? WHERE id = ?").run(tie, id);
  }

  const ordered = listFindings().map((f) => f.id);
  // Most-recently-inserted (last created) must still come first, not an
  // arbitrary tie order.
  assert.deepEqual(ordered, [...ids].reverse());
});

/**
 * Regression: Finding.bountyStatus is set at creation ('not_applicable')
 * and never updated by the real pipeline — markAwarded/markPaid operate on
 * the Earning ledger, not the Finding row. Code that filtered/counted by
 * `finding.bountyStatus === 'paid'` therefore always read zero paid
 * findings, even with real paid earnings on record. Fixed in
 * src/services/metrics.ts, src/telegram/views.ts, and
 * src/telegram/dailySummary.ts to derive paid state from Earnings instead.
 */
test("getMetrics().paid reflects real paid earnings, not the unused Finding.bountyStatus field", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  assert.equal(finding.bountyStatus, "not_applicable"); // confirms the field really is never updated

  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 100, currency: "USD" });
  markPaid(earning.id);

  assert.equal(getMetrics().paid, 1);
});

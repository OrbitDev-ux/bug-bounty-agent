import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding } from "../src/domain/findings.js";
import { createEarning, findOrCreateEarningByExternalSubmissionId } from "../src/domain/earnings.js";
import { recordCost, listCosts } from "../src/domain/costs.js";
import { getSettings, updateSettings, isQuiet, setQuietUntil } from "../src/domain/settings.js";
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

test("finding.submittedAt is stamped once, on first arrival at 'submitted' (time-to-bounty, section 30)", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  assert.equal(finding.submittedAt, null);
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  const submitted = transitionFinding(finding.id, "submitted");
  assert.ok(submitted.submittedAt);
  assert.equal(submitted.acceptedAt, null);
});

test("finding.acceptedAt is stamped once, on first arrival at 'accepted'", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  transitionFinding(finding.id, "submitted");
  transitionFinding(finding.id, "triaged");
  const accepted = transitionFinding(finding.id, "accepted");
  assert.ok(accepted.acceptedAt);
  assert.ok(accepted.submittedAt); // stays set from the earlier transition
});

test("earnings: findOrCreateEarningByExternalSubmissionId is idempotent (section 45)", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  const first = findOrCreateEarningByExternalSubmissionId("ext-123", { findingId: finding.id, programId: program.id });
  const second = findOrCreateEarningByExternalSubmissionId("ext-123", { findingId: finding.id, programId: program.id });
  assert.equal(first.id, second.id);
});

test("earnings: two different external submission ids create two distinct earnings", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  const a = findOrCreateEarningByExternalSubmissionId("ext-a", { findingId: finding.id, programId: program.id });
  const b = findOrCreateEarningByExternalSubmissionId("ext-b", { findingId: finding.id, programId: program.id });
  assert.notEqual(a.id, b.id);
});

test("earnings: external submission id must be unique at the DB level (dedup identity)", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  createEarning({ findingId: finding.id, programId: program.id, externalSubmissionId: "dup-1" });
  assert.throws(() => createEarning({ findingId: finding.id, programId: program.id, externalSubmissionId: "dup-1" }));
});

test("earnings: two earnings with no external submission id (null) never collide", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  assert.doesNotThrow(() => {
    createEarning({ findingId: finding.id, programId: program.id });
    createEarning({ findingId: finding.id, programId: program.id });
  });
});

test("costs: source defaults to 'manual' unless given, category supports 'tools'", () => {
  const cost = recordCost({ category: "tools", amount: 10 });
  assert.equal(cost.source, "manual");
  const auto = recordCost({ category: "claude_api", amount: 0.1, source: "auto:runClaude" });
  assert.equal(auto.source, "auto:runClaude");
  assert.equal(listCosts().length, 2);
});

test("settings: notification preferences default to enabled, are individually toggleable", () => {
  const settings = getSettings();
  assert.equal(settings.notifications.bountyAlerts, true);
  assert.equal(settings.notifications.dailySummary, true);

  updateSettings({ notifications: { bountyAlerts: false } });
  const updated = getSettings();
  assert.equal(updated.notifications.bountyAlerts, false);
  assert.equal(updated.notifications.dailySummary, true); // untouched
});

test("settings: quiet mode is off by default, on while quietUntil is in the future, off again after it passes", () => {
  assert.equal(isQuiet(), false);

  const future = new Date(Date.now() + 60_000).toISOString();
  setQuietUntil(future);
  assert.equal(isQuiet(new Date()), true);
  assert.equal(isQuiet(new Date(Date.now() + 120_000)), false); // past the quiet window

  setQuietUntil(null);
  assert.equal(isQuiet(), false);
});

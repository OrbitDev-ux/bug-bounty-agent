import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding } from "../src/domain/findings.js";
import { createTask } from "../src/domain/tasks.js";
import { createApproval } from "../src/domain/approvals.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { createGoal } from "../src/domain/goals.js";
import {
  renderOverview,
  renderEarnings,
  renderPrograms,
  renderProgramDetail,
  renderFindings,
  renderFindingDetail,
  renderTasks,
  renderApprovals,
  renderAgent,
  renderActivity,
  renderSettings,
  renderResearchSessionDetail,
} from "../src/web/pages.js";
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

test("renderOverview produces well-formed HTML with the expected sections, on an empty-ish DB", async () => {
  const html = await renderOverview();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Overview/);
  assert.match(html, /Pending Approvals/);
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("renderEarnings shows CONFIRMED REVENUE = PAID messaging and never crashes with no data", async () => {
  const html = await renderEarnings("30d");
  assert.match(html, /CONFIRMED REVENUE = PAID/);
  assert.doesNotMatch(html, /undefined/);
});

test("renderEarnings reflects a real paid earning with currency preserved", async () => {
  const finding = createFinding({ programId: program.id, title: "F", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 250, currency: "KRW" });
  markPaid(earning.id);

  const html = await renderEarnings("all");
  assert.match(html, /KRW/);
  assert.match(html, /250\.00/);
});

test("renderEarnings shows goal progress", async () => {
  createGoal({ name: "MacBook Pro", targetAmount: 2_500_000, targetCurrency: "KRW" });
  const html = await renderEarnings("all");
  assert.match(html, /MacBook Pro/);
});

test("renderPrograms lists the program and flags never-verified scope", () => {
  const html = renderPrograms();
  assert.match(html, /Test Program/);
  assert.match(html, /NEVER VERIFIED/);
});

test("renderProgramDetail returns null for an unknown id, HTML for a real one", () => {
  assert.equal(renderProgramDetail("does-not-exist"), null);
  const html = renderProgramDetail(program.id);
  assert.match(html!, /Test Program/);
  assert.match(html!, /example\.com/);
});

test("renderResearchSessionDetail returns null for an unknown id", () => {
  assert.equal(renderResearchSessionDetail("does-not-exist"), null);
});

test("renderFindings and renderFindingDetail reflect a real finding", () => {
  const finding = createFinding({ programId: program.id, title: "XSS in search", asset: "example.com", category: "XSS" });
  transitionFinding(finding.id, "candidate");

  const list = renderFindings();
  assert.match(list, /XSS in search/);

  assert.equal(renderFindingDetail("does-not-exist"), null);
  const detail = renderFindingDetail(finding.id);
  assert.match(detail!, /XSS in search/);
  assert.match(detail!, />XSS</);
});

test("renderTasks reflects a real task", () => {
  createTask({ type: "research", programId: program.id, target: "example.com research" });
  const html = renderTasks();
  assert.match(html, /example\.com research/);
});

test("renderApprovals lists a pending approval and includes a decide form", () => {
  createApproval({ requestedAction: "Continue validation for asset X" });
  const html = renderApprovals();
  assert.match(html, /Continue validation for asset X/);
  assert.match(html, /<form/);
  assert.match(html, /telegramUserId/);
});

test("renderAgent includes health check results", async () => {
  const html = await renderAgent();
  assert.match(html, /SQLite/);
  assert.match(html, /Claude CLI/);
});

test("renderActivity never crashes on an empty log", () => {
  const html = renderActivity();
  assert.match(html, /Activity/);
});

test("renderSettings reflects current settings and never exposes a safety-disabling control", () => {
  const html = renderSettings();
  assert.match(html, /AI Model/);
  assert.doesNotMatch(html, /disable.*scope/i);
  assert.doesNotMatch(html, /disable.*approval/i);
});

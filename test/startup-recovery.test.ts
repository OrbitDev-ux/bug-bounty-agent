import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createTask, transitionTask, getTask } from "../src/domain/tasks.js";
import { startResearchSession, getResearchSession } from "../src/domain/researchSessions.js";
import { createApproval, getApproval } from "../src/domain/approvals.js";
import { startScheduler, getSchedulerState } from "../src/domain/schedulerState.js";
import { runStartupRecovery } from "../src/agent/startupRecovery.js";
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

test("recovers a stale 'running' task on startup, never to 'completed'", () => {
  const task = createTask({ type: "research", programId: program.id, target: "x" });
  transitionTask(task.id, "running", { timeoutAt: new Date(Date.now() - 1000).toISOString() });

  const report = runStartupRecovery();
  assert.deepEqual(report.recoveredTaskIds, [task.id]);
  assert.notEqual(getTask(task.id)?.status, "completed");
});

test("marks a stale 'running' research session as failed with a NEEDS_REVIEW note, never 'completed'", () => {
  const session = startResearchSession({ programId: program.id, goal: "interrupted goal" });

  const report = runStartupRecovery();
  assert.deepEqual(report.recoveredResearchSessionIds, [session.id]);
  const reloaded = getResearchSession(session.id)!;
  assert.equal(reloaded.status, "failed");
  assert.match(reloaded.summary, /NEEDS_REVIEW/);
});

test("expires stale pending approvals on startup", () => {
  const approval = createApproval({ requestedAction: "old", ttlHours: -1 });
  const report = runStartupRecovery();
  assert.equal(report.expiredApprovalCount, 1);
  assert.equal(getApproval(approval.id)?.status, "expired");
});

test("resets a scheduler_state left 'running' by a crashed process to 'stopped', never silently resumed", () => {
  startScheduler({});
  assert.equal(getSchedulerState().status, "running");

  const report = runStartupRecovery();
  assert.equal(report.schedulerStateReset, true);
  assert.equal(getSchedulerState().status, "stopped");
});

test("is a no-op (and reports so) on a clean startup with nothing to recover", () => {
  const report = runStartupRecovery();
  assert.deepEqual(report.recoveredTaskIds, []);
  assert.deepEqual(report.recoveredResearchSessionIds, []);
  assert.equal(report.expiredApprovalCount, 0);
  assert.equal(report.schedulerStateReset, false);
});

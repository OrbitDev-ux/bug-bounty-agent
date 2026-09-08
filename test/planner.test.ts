import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createTask, transitionTask } from "../src/domain/tasks.js";
import { createApproval } from "../src/domain/approvals.js";
import { selectNextTask, runSafetyHousekeeping } from "../src/agent/planner.js";
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

test("selectNextTask: empty queue returns no task", () => {
  const decision = selectNextTask();
  assert.equal(decision.nextTask, null);
});

test("selectNextTask: prefers 'high' priority over 'normal' and 'low'", () => {
  createTask({ type: "research", programId: program.id, target: "low one", priority: "low" });
  createTask({ type: "research", programId: program.id, target: "normal one", priority: "normal" });
  const high = createTask({ type: "research", programId: program.id, target: "high one", priority: "high" });

  const decision = selectNextTask();
  assert.equal(decision.nextTask?.id, high.id);
  assert.equal(decision.priority, "high");
});

test("selectNextTask: within the same priority, picks the oldest first (FIFO)", async () => {
  const first = createTask({ type: "research", programId: program.id, target: "first" });
  await new Promise((r) => setTimeout(r, 5));
  createTask({ type: "research", programId: program.id, target: "second" });

  const decision = selectNextTask();
  assert.equal(decision.nextTask?.id, first.id);
});

test("selectNextTask: flags non-research/scope_check/report_draft task types as needing review", () => {
  createTask({ type: "validate", programId: program.id, target: "x" });
  const decision = selectNextTask();
  assert.equal(decision.risk, "needs_review");
});

test("runSafetyHousekeeping recovers stale tasks and sweeps expired approvals", () => {
  const task = createTask({ type: "research", programId: program.id, target: "x" });
  transitionTask(task.id, "running", { timeoutAt: new Date(Date.now() - 1000).toISOString() });
  createApproval({ requestedAction: "old", ttlHours: -1 });

  const recoverCalls: string[] = [];
  const result = runSafetyHousekeeping((taskId) => recoverCalls.push(taskId));

  assert.deepEqual(result.recoveredTaskIds, [task.id]);
  assert.deepEqual(recoverCalls, [task.id]);
  assert.equal(result.expiredApprovalCount, 1);
});

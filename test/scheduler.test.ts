import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createTask, getTask, transitionTask } from "../src/domain/tasks.js";
import { startScheduler } from "../src/domain/schedulerState.js";
import { runOnce, recoverStaleTasksNow, pauseAgent, resumeAgent, stopAgent } from "../src/agent/scheduler.js";
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

test("runOnce reports nothing to do on an empty queue (no network call needed)", async () => {
  const result = await runOnce();
  assert.equal(result.ranTask, false);
});

test("runOnce blocks a task type it has no scheduler handler for, without any network call", async () => {
  const task = createTask({ type: "validate", programId: program.id, target: "x" });
  const result = await runOnce();

  assert.equal(result.ranTask, true);
  assert.equal(result.taskId, task.id);
  assert.equal(getTask(task.id)?.status, "blocked");
  assert.match(getTask(task.id)?.failureReason ?? "", /No scheduler handler/);
});

test("recoverStaleTasksNow requeues under the retry limit", () => {
  const task = createTask({ type: "research", programId: program.id, target: "x" });
  transitionTask(task.id, "running", { timeoutAt: new Date(Date.now() - 1000).toISOString() });

  const result = recoverStaleTasksNow(3);
  assert.deepEqual(result.recoveredTaskIds, [task.id]);
  assert.deepEqual(result.requeuedTaskIds, [task.id]);
  assert.equal(getTask(task.id)?.status, "queued");
});

test("recoverStaleTasksNow leaves a task failed for human review once retries are exhausted", () => {
  const task = createTask({ type: "research", programId: program.id, target: "x" });
  transitionTask(task.id, "running", { timeoutAt: new Date(Date.now() - 1000).toISOString() });

  const result = recoverStaleTasksNow(-1); // maxRetries: -1 means even the first recovery (retryCount 1) exceeds it
  assert.deepEqual(result.requeuedTaskIds, []);
  assert.equal(getTask(task.id)?.status, "failed");
});

test("pause only works while running", () => {
  assert.throws(() => pauseAgent(), /not 'running'/);
});

test("stopAgent always succeeds and returns to 'stopped'", () => {
  const state = stopAgent();
  assert.equal(state.status, "stopped");
});

test("pause -> resume round-trips back to running, preserving state", () => {
  startScheduler({});
  const paused = pauseAgent();
  assert.equal(paused.status, "paused");
  const resumed = resumeAgent();
  assert.equal(resumed.status, "running");
});

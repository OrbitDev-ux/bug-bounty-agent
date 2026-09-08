import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import {
  createTask,
  transitionTask,
  listStaleRunningTasks,
  recoverStaleTask,
  requeueRecoveredTask,
  getTask,
} from "../src/domain/tasks.js";
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

test("a running task with a future timeout is not stale", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  const future = new Date(Date.now() + 60_000).toISOString();
  transitionTask(task.id, "running", { timeoutAt: future });

  const stale = listStaleRunningTasks(new Date());
  assert.equal(stale.length, 0);
});

test("a running task past its timeout is detected as stale", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  const past = new Date(Date.now() - 60_000).toISOString();
  transitionTask(task.id, "running", { timeoutAt: past });

  const stale = listStaleRunningTasks(new Date());
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.id, task.id);
});

test("recoverStaleTask moves a stuck task to failed, never to completed (no auto-success)", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  const past = new Date(Date.now() - 60_000).toISOString();
  transitionTask(task.id, "running", { timeoutAt: past });

  const recovered = recoverStaleTask(task.id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.retryCount, 1);
  assert.match(recovered.failureReason ?? "", /Recovered/);
});

test("recovering clears the timeout so it isn't detected as stale again", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  transitionTask(task.id, "running", { timeoutAt: new Date(Date.now() - 1000).toISOString() });
  recoverStaleTask(task.id);
  assert.equal(getTask(task.id)?.timeoutAt, null);
});

test("requeueRecoveredTask requeues when under the retry limit", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  transitionTask(task.id, "running", { timeoutAt: new Date(Date.now() - 1000).toISOString() });
  recoverStaleTask(task.id); // retryCount -> 1

  const result = requeueRecoveredTask(task.id, 3);
  assert.equal(result.status, "queued");
});

test("requeueRecoveredTask leaves the task failed (for human review) once retries are exhausted", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });

  // Fail-and-requeue repeatedly to exhaust a maxRetries of 2.
  for (let i = 0; i < 3; i++) {
    transitionTask(task.id, "running", { timeoutAt: new Date(Date.now() - 1000).toISOString() });
    recoverStaleTask(task.id);
    const result = requeueRecoveredTask(task.id, 2);
    if (result.status === "failed") {
      assert.equal(getTask(task.id)?.status, "failed");
      return;
    }
  }
  assert.fail("expected the task to end up failed for human review after exhausting retries");
});

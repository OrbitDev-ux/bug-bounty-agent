import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createTask, transitionTask, getTask, listTasks, InvalidTaskTransitionError } from "../src/domain/tasks.js";
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

test("new task starts in queued state", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  assert.equal(task.status, "queued");
  assert.equal(getTask(task.id)?.status, "queued");
});

test("follows the golden path: queued -> running -> waiting_approval -> approved -> completed", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  transitionTask(task.id, "running");
  transitionTask(task.id, "waiting_approval");
  transitionTask(task.id, "approved");
  const done = transitionTask(task.id, "completed", { result: JSON.stringify({ ok: true }) });
  assert.equal(done.status, "completed");
  assert.equal(done.result, JSON.stringify({ ok: true }));
});

test("rejects an illegal transition (queued -> completed)", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  assert.throws(() => transitionTask(task.id, "completed"), InvalidTaskTransitionError);
});

test("rejected is a terminal state", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  transitionTask(task.id, "running");
  transitionTask(task.id, "waiting_approval");
  const rejected = transitionTask(task.id, "rejected");
  assert.equal(rejected.status, "rejected");
  assert.throws(() => transitionTask(task.id, "queued"), InvalidTaskTransitionError);
});

test("failed tasks can only be retried by moving back to queued", () => {
  const task = createTask({ type: "research", programId: program.id, target: "example.com" });
  transitionTask(task.id, "running");
  const failed = transitionTask(task.id, "failed", { failureReason: "network error" });
  assert.equal(failed.failureReason, "network error");
  const retried = transitionTask(task.id, "queued");
  assert.equal(retried.status, "queued");
});

test("listTasks filters by status", () => {
  const t1 = createTask({ type: "research", programId: program.id, target: "example.com" });
  createTask({ type: "research", programId: program.id, target: "example.com" });
  transitionTask(t1.id, "running");

  const running = listTasks("running");
  assert.equal(running.length, 1);
  assert.equal(running[0]?.id, t1.id);
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import {
  getSchedulerState,
  startScheduler,
  stopScheduler,
  pauseScheduler,
  resumeScheduler,
  incrementTasksRun,
  incrementBrowserOps,
  runLimitReached,
} from "../src/domain/schedulerState.js";

beforeEach(() => {
  freshDb();
});

test("scheduler starts 'stopped' before anything runs it", () => {
  assert.equal(getSchedulerState().status, "stopped");
});

test("start -> running, with counters reset and limits applied", () => {
  const state = startScheduler({ maxTasksPerRun: 5, maxBrowserOps: 20 });
  assert.equal(state.status, "running");
  assert.equal(state.tasksRunThisRun, 0);
  assert.equal(state.maxTasksPerRun, 5);
  assert.equal(state.maxBrowserOps, 20);
});

test("pause only works from running, and preserves state", () => {
  assert.throws(() => pauseScheduler(), /not 'running'/);

  startScheduler({});
  incrementTasksRun();
  const paused = pauseScheduler();
  assert.equal(paused.status, "paused");
  assert.equal(paused.tasksRunThisRun, 1); // preserved, not reset
});

test("resume only works from paused, and goes back to running", () => {
  assert.throws(() => resumeScheduler(), /not 'paused'/);

  startScheduler({});
  pauseScheduler();
  const resumed = resumeScheduler();
  assert.equal(resumed.status, "running");
});

test("stop clears current task and returns to stopped", () => {
  startScheduler({});
  const stopped = stopScheduler();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.currentTaskId, null);
});

test("runLimitReached: max_tasks_per_run", () => {
  const state = startScheduler({ maxTasksPerRun: 2 });
  incrementTasksRun();
  const afterOne = incrementTasksRun();
  const check = runLimitReached(afterOne);
  assert.equal(check.reached, true);
  assert.match(check.reason ?? "", /max_tasks_per_run/);
  void state;
});

test("runLimitReached: max_browser_ops", () => {
  startScheduler({ maxBrowserOps: 3 });
  incrementBrowserOps(3);
  const check = runLimitReached(getSchedulerState());
  assert.equal(check.reached, true);
  assert.match(check.reason ?? "", /max_browser_ops/);
});

test("runLimitReached: no limits configured never trips", () => {
  const state = startScheduler({});
  incrementTasksRun();
  incrementBrowserOps(1000);
  const check = runLimitReached(getSchedulerState());
  assert.equal(check.reached, false);
  void state;
});

test("runLimitReached: max_runtime_ms", () => {
  startScheduler({ maxRuntimeMs: 10 });
  const state = getSchedulerState();
  const future = new Date(new Date(state.startedAt!).getTime() + 1000);
  const check = runLimitReached(state, future);
  assert.equal(check.reached, true);
  assert.match(check.reason ?? "", /max_runtime_ms/);
});

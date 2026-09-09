import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { freshDb } from "./testDb.js";
import { getWorkerProcessStatus } from "../src/agent/workerProcess.js";
import { executeCapability } from "../src/agent/capabilities.js";
import { getSchedulerState } from "../src/domain/schedulerState.js";

const PID_FILE = resolve(process.cwd(), "data", ".worker.pid");

/**
 * Regression coverage for the real gap found in this session: `/resume`
 * only flipped a DB flag with no worker process actually consuming the
 * queue. These tests cover the deterministic PID-liveness logic
 * (getWorkerProcessStatus) without ever actually spawning a real worker
 * process — that's exercised manually/live, matching the project's existing
 * discipline of not making live Claude/Safari calls from the automated
 * suite (see test/orchestrator-pipeline.test.ts).
 */

beforeEach(() => {
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  if (existsSync(PID_FILE)) rmSync(PID_FILE);
});

afterEach(() => {
  if (existsSync(PID_FILE)) rmSync(PID_FILE);
});

test("getWorkerProcessStatus reports not running when no pidfile exists", () => {
  const status = getWorkerProcessStatus();
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
});

test("getWorkerProcessStatus reports running for this test process's own real, live PID", () => {
  writeFileSync(PID_FILE, String(process.pid), "utf8");
  const status = getWorkerProcessStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
});

test("getWorkerProcessStatus detects a stale pidfile (dead process) and cleans it up rather than trusting it", () => {
  // PID 999999 is extremely unlikely to be a real running process on any
  // real machine — this is the "process crashed / finished, file never got
  // cleaned up" scenario the whole liveness check exists to catch.
  writeFileSync(PID_FILE, "999999", "utf8");
  const status = getWorkerProcessStatus();
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
  assert.equal(existsSync(PID_FILE), false, "stale pidfile should be removed, not left behind to mislead the next check");
});

test("getWorkerProcessStatus treats a non-numeric pidfile as not running", () => {
  writeFileSync(PID_FILE, "not-a-pid", "utf8");
  const status = getWorkerProcessStatus();
  assert.equal(status.running, false);
});

// --- CONTROL_AGENT_RESUME / CONTROL_AGENT_START capability regression ---
//
// The real bug found live: the scheduler's default state is 'stopped' (never
// 'paused') until something has actually run once. resumeScheduler() only
// succeeds from 'paused', so pressing "resume" against a fresh/stopped
// scheduler always threw — and since nothing else in the old code path ran
// after that throw, no worker process was ever started either. These tests
// never let the capability actually spawn a real process (that would run a
// live worker loop from an automated test) — they pre-seed the pidfile with
// this test process's own real PID so `getWorkerProcessStatus().running` is
// already true, exercising the "already running" branch deterministically.

beforeEach(() => {
  freshDb();
});

test("CONTROL_AGENT_RESUME succeeds even when the scheduler was never started (status 'stopped', not 'paused')", async () => {
  assert.equal(getSchedulerState().status, "stopped");
  writeFileSync(PID_FILE, String(process.pid), "utf8"); // stand-in for "a worker process is already alive"

  const result = await executeCapability("CONTROL_AGENT_RESUME");
  assert.equal(result.ok, true, `expected ok, got: ${result.summary}`);
  assert.match(result.summary, /already running/i);
});

test("CONTROL_AGENT_START reports an already-running worker without trying to spawn a duplicate", async () => {
  writeFileSync(PID_FILE, String(process.pid), "utf8");
  const result = await executeCapability("CONTROL_AGENT_START");
  assert.equal(result.ok, true);
  assert.match(result.summary, new RegExp(String(process.pid)));
});

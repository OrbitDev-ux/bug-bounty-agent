import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "../logging/logger.js";

/**
 * Fixes a real gap found in this session: `/resume` (and the chat "다시
 * 시작하자" control action) only ever flipped `scheduler_state.status` in
 * the DB. `runWorkerLoop()` DOES respect that flag between tasks — but only
 * if a worker loop process is actually alive and looping. With no daemon
 * installed (the default — see docs/daemon.md on why an always-on daemon is
 * not auto-installed) and no `bba agent start` running in a terminal,
 * pressing "resume" changed a database row and nothing else: no task ever
 * actually ran. This module gives Telegram/chat a way to actually start a
 * real, bounded worker process, and to honestly report whether one is
 * currently alive — never just assume the DB flag reflects reality.
 */

const PID_FILE = resolve(process.cwd(), "data", ".worker.pid");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check only, does not actually signal
    return true;
  } catch {
    return false;
  }
}

export interface WorkerProcessStatus {
  running: boolean;
  pid: number | null;
}

/** Reads the PID file and verifies the process is actually alive — a stale file from a finished/crashed run is cleaned up, never trusted blindly. */
export function getWorkerProcessStatus(): WorkerProcessStatus {
  if (!existsSync(PID_FILE)) return { running: false, pid: null };
  const raw = readFileSync(PID_FILE, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid) || !isAlive(pid)) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      // best-effort cleanup
    }
    return { running: false, pid: null };
  }
  return { running: true, pid };
}

export interface StartWorkerResult {
  started: boolean;
  alreadyRunning: boolean;
  pid: number | null;
  reason: string;
}

/**
 * Spawns a single bounded worker run (`bba agent start`, default limits —
 * NOT `--daemon`, so it stops itself once the queue empties or a limit is
 * hit, same as running it by hand in a terminal) detached from this
 * process, so a short-lived CLI command or the Telegram bot itself can
 * trigger real task execution without blocking on it. Refuses if one is
 * already alive rather than spawning a second overlapping loop.
 */
export function startBoundedWorkerRun(): StartWorkerResult {
  const existing = getWorkerProcessStatus();
  if (existing.running) {
    return { started: false, alreadyRunning: true, pid: existing.pid, reason: `A worker process is already running (pid ${existing.pid}).` };
  }

  mkdirSync(dirname(PID_FILE), { recursive: true });

  const child = spawn("npx", ["tsx", "src/cli/index.ts", "agent", "start"], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  if (!child.pid) {
    return { started: false, alreadyRunning: false, pid: null, reason: "Failed to spawn worker process." };
  }

  writeFileSync(PID_FILE, String(child.pid), "utf8");
  log("scheduler_started", { pid: child.pid, note: "bounded worker run started via startBoundedWorkerRun()" });
  return { started: true, alreadyRunning: false, pid: child.pid, reason: `Worker process started (pid ${child.pid}), bounded default limits.` };
}

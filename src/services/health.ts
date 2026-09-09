// Health monitoring (project brief v0.3 section 30). Each check is cheap and
// side-effect-free (no paid Claude API calls — `claude --version` costs
// nothing) so this can be run frequently (every worker-loop tick, a
// Telegram /status call, a dashboard page load) without meaningful cost or
// load.

import { spawn } from "node:child_process";
import { getDb } from "../db/client.js";
import { telegramConfigStatus } from "../config/env.js";
import { getSchedulerState } from "../domain/schedulerState.js";
import { listStaleRunningTasks } from "../domain/tasks.js";
import * as safari from "../safari/controller.js";
import type { HealthCheckResult, HealthReport, HealthStatus } from "../domain/types.js";

function worstOf(a: HealthStatus, b: HealthStatus): HealthStatus {
  const rank: Record<HealthStatus, number> = { OK: 0, DEGRADED: 1, FAILED: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function checkSqlite(): HealthCheckResult {
  try {
    getDb().prepare("SELECT 1").get();
    return { component: "SQLite", status: "OK", detail: "reachable" };
  } catch (err) {
    return { component: "SQLite", status: "FAILED", detail: (err as Error).message };
  }
}

function checkClaudeCli(timeoutMs = 5000): Promise<HealthCheckResult> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"]);
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ component: "Claude CLI", status: "FAILED", detail: "timed out" });
    }, timeoutMs);
    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ component: "Claude CLI", status: "FAILED", detail: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { component: "Claude CLI", status: "OK", detail: stdout.trim() }
          : { component: "Claude CLI", status: "FAILED", detail: `exited with code ${code}` },
      );
    });
  });
}

async function checkSafariHealth(): Promise<HealthCheckResult> {
  try {
    const tab = await safari.currentTab();
    return { component: "Safari", status: "OK", detail: `reachable (current tab: ${tab.title || tab.url})` };
  } catch (err) {
    return { component: "Safari", status: "FAILED", detail: (err as Error).message };
  }
}

function checkTelegramHealth(): HealthCheckResult {
  const status = telegramConfigStatus();
  if (status === "ready") return { component: "Telegram", status: "OK", detail: "configured" };
  return { component: "Telegram", status: "DEGRADED", detail: `not fully configured (${status})` };
}

function checkSchedulerHealth(): HealthCheckResult {
  try {
    const state = getSchedulerState();
    return { component: "Scheduler", status: "OK", detail: `${state.status}` };
  } catch (err) {
    return { component: "Scheduler", status: "FAILED", detail: (err as Error).message };
  }
}

function checkQueueHealth(): HealthCheckResult {
  try {
    const stale = listStaleRunningTasks();
    if (stale.length > 0) {
      return { component: "Queue", status: "DEGRADED", detail: `${stale.length} task(s) stuck past their timeout, awaiting recovery` };
    }
    return { component: "Queue", status: "OK", detail: "no stuck tasks" };
  } catch (err) {
    return { component: "Queue", status: "FAILED", detail: (err as Error).message };
  }
}

/** Runs all health checks and returns the overall (worst-of) status. Safe to call often. */
export async function checkHealth(): Promise<HealthReport> {
  const checks: HealthCheckResult[] = [checkSqlite(), await checkClaudeCli(), await checkSafariHealth(), checkTelegramHealth(), checkSchedulerHealth(), checkQueueHealth()];

  let overall: HealthStatus = "OK";
  for (const c of checks) overall = worstOf(overall, c.status);

  return { overall, checks, checkedAt: new Date().toISOString() };
}

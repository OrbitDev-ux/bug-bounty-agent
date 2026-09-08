// Dashboard backend layer (project brief section 37). Deliberately just
// data-shaping functions over the existing repos — no HTTP server, no UI.
// A future web dashboard (or the Telegram daily summary, or the CLI) can
// call these directly; wiring an actual HTTP API is out of scope for v0.2.

import { listTasks } from "../domain/tasks.js";
import { listApprovals } from "../domain/approvals.js";
import { listPrograms } from "../domain/programs.js";
import { listFindings } from "../domain/findings.js";
import { summarizeEarnings, listEarnings, type EarningsSummary } from "../domain/earnings.js";
import { getSchedulerState } from "../domain/schedulerState.js";
import { listResearchSessions } from "../domain/researchSessions.js";
import * as safari from "../safari/controller.js";
import type { Task, Approval, Program, Finding, Earning } from "../domain/types.js";

export interface AgentStatusSummary {
  schedulerStatus: string;
  currentTaskId: string | null;
  queueDepth: number;
  pendingApprovals: number;
  browserAvailable: boolean;
  lastResearchGoal: string | null;
}

export async function getAgentStatus(): Promise<AgentStatusSummary> {
  const scheduler = getSchedulerState();
  let browserAvailable = false;
  try {
    await safari.currentTab();
    browserAvailable = true;
  } catch {
    browserAvailable = false;
  }
  const lastResearch = listResearchSessions()[0];
  return {
    schedulerStatus: scheduler.status,
    currentTaskId: scheduler.currentTaskId,
    queueDepth: listTasks("queued").length,
    pendingApprovals: listApprovals("pending").length,
    browserAvailable,
    lastResearchGoal: lastResearch?.goal ?? null,
  };
}

export function getQueue(): Task[] {
  return listTasks("queued");
}

export function getPendingApprovals(): Approval[] {
  return listApprovals("pending");
}

export interface ProgramStats {
  total: number;
  active: number;
  paused: number;
  closed: number;
}

export function getProgramStats(): ProgramStats {
  const programs = listPrograms();
  return {
    total: programs.length,
    active: programs.filter((p: Program) => p.status === "active").length,
    paused: programs.filter((p: Program) => p.status === "paused").length,
    closed: programs.filter((p: Program) => p.status === "closed").length,
  };
}

export interface FindingStats {
  total: number;
  byStatus: Record<string, number>;
  candidatesAwaitingReview: number;
  likelyDuplicates: number;
}

export function getFindingStats(): FindingStats {
  const findings = listFindings();
  const byStatus: Record<string, number> = {};
  for (const f of findings) {
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  }
  return {
    total: findings.length,
    byStatus,
    candidatesAwaitingReview: findings.filter((f: Finding) => f.status === "candidate").length,
    likelyDuplicates: findings.filter((f: Finding) => f.duplicateVerdict === "LIKELY_DUPLICATE").length,
  };
}

export function getEarningsSummary(): EarningsSummary {
  return summarizeEarnings();
}

export interface RevenueTimelinePoint {
  date: string; // YYYY-MM-DD
  amount: number; // paid-only, per section 45 — never simulated/awarded/pending
}

/** Daily paid-revenue timeline. Only bountyStatus === "paid" rows contribute (section 45: no fake revenue). */
export function getRevenueTimeline(): RevenueTimelinePoint[] {
  const earnings = listEarnings();
  const byDate = new Map<string, number>();
  for (const e of earnings as Earning[]) {
    if (e.bountyStatus !== "paid" || !e.paidAt || e.amount === null) continue;
    const date = e.paidAt.slice(0, 10);
    byDate.set(date, (byDate.get(date) ?? 0) + e.amount);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount }));
}

// Dashboard backend layer (project brief section 37). Deliberately just
// data-shaping functions over the existing repos — the web UI (src/web) and
// the CLI's `dashboard status` both call these directly.

import { listTasks } from "../domain/tasks.js";
import { listApprovals } from "../domain/approvals.js";
import { listPrograms } from "../domain/programs.js";
import { listFindings, listFindingsForProgram } from "../domain/findings.js";
import { listReports } from "../domain/reports.js";
import { summarizeEarnings, listEarnings, type EarningsSummary } from "../domain/earnings.js";
import { getSchedulerState } from "../domain/schedulerState.js";
import { getWorkerProcessStatus } from "../agent/workerProcess.js";
import { listResearchSessions } from "../domain/researchSessions.js";
import { listCandidates, compareCandidates, type ScoredCandidate } from "../domain/programCandidates.js";
import * as safari from "../safari/controller.js";
import type { Task, Approval, Program, Finding, Earning, ProgramCandidate } from "../domain/types.js";

export interface AgentStatusSummary {
  schedulerStatus: string;
  currentTaskId: string | null;
  queueDepth: number;
  pendingApprovals: number;
  browserAvailable: boolean;
  lastResearchGoal: string | null;
  /** Whether a real worker process is actually alive — the scheduler flag alone does not imply this. See src/agent/workerProcess.ts. */
  workerProcessRunning: boolean;
  workerProcessPid: number | null;
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
  const worker = getWorkerProcessStatus();
  return {
    schedulerStatus: scheduler.status,
    currentTaskId: scheduler.currentTaskId,
    queueDepth: listTasks("queued").length,
    pendingApprovals: listApprovals("pending").length,
    browserAvailable,
    lastResearchGoal: lastResearch?.goal ?? null,
    workerProcessRunning: worker.running,
    workerProcessPid: worker.pid,
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
  currency: string;
  amount: number; // paid-only, per section 45 — never simulated/awarded/pending
}

/** Daily paid-revenue timeline, currency-correct (section 18/23) — never sums different currencies into one point. */
export function getRevenueTimeline(): RevenueTimelinePoint[] {
  const earnings = listEarnings();
  const byKey = new Map<string, RevenueTimelinePoint>();
  for (const e of earnings as Earning[]) {
    if (e.bountyStatus !== "paid" || !e.paidAt || e.amount === null) continue;
    const date = e.paidAt.slice(0, 10);
    const currency = e.currency ?? "UNSET";
    const key = `${date}|${currency}`;
    const point = byKey.get(key) ?? { date, currency, amount: 0 };
    point.amount += e.amount;
    byKey.set(key, point);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency));
}

export type TimelineWindow = "today" | "7d" | "30d" | "90d" | "all";

/** Restricts the full timeline to a window (section 18). "today" compares by day-string, not a rolling 24h. */
export function getRevenueTimelineForWindow(window: TimelineWindow, now: Date = new Date()): RevenueTimelinePoint[] {
  const timeline = getRevenueTimeline();
  if (window === "all") return timeline;

  const today = now.toISOString().slice(0, 10);
  if (window === "today") return timeline.filter((p) => p.date === today);

  const days = window === "7d" ? 7 : window === "30d" ? 30 : 90;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return timeline.filter((p) => p.date >= cutoff);
}

export interface ProgramAnalytics {
  programId: string;
  programName: string;
  reports: number;
  accepted: number;
  paidCount: number;
  /** Per-currency paid revenue — never mixed (section 19/23). */
  paidRevenueByCurrency: { currency: string; total: number }[];
  averageBountyByCurrency: { currency: string; average: number }[];
  medianBountyByCurrency: { currency: string; median: number }[];
  largestBountyByCurrency: { currency: string; amount: number }[];
}

/** Never fabricates an average/median/largest when there's no paid data for a currency — that currency is simply absent from the arrays. */
export function getProgramAnalytics(programId: string): ProgramAnalytics {
  const program = listPrograms().find((p) => p.id === programId);
  const findings = listFindingsForProgram(programId);
  const findingIds = new Set(findings.map((f) => f.id));
  const reports = listReports().filter((r) => findings.some((f) => f.id === r.findingId)).length;
  const accepted = findings.filter((f) => f.status === "accepted").length;

  const earnings = listEarnings().filter((e) => e.programId === programId && findingIds.has(e.findingId));
  const paid = earnings.filter((e) => e.bountyStatus === "paid" && e.amount !== null);

  const byCurrency = new Map<string, number[]>();
  for (const e of paid) {
    const list = byCurrency.get(e.currency ?? "UNSET") ?? [];
    list.push(e.amount!);
    byCurrency.set(e.currency ?? "UNSET", list);
  }

  const paidRevenueByCurrency: { currency: string; total: number }[] = [];
  const averageBountyByCurrency: { currency: string; average: number }[] = [];
  const medianBountyByCurrency: { currency: string; median: number }[] = [];
  const largestBountyByCurrency: { currency: string; amount: number }[] = [];

  for (const [currency, amounts] of byCurrency) {
    const sorted = [...amounts].sort((a, b) => a - b);
    paidRevenueByCurrency.push({ currency, total: sorted.reduce((s, a) => s + a, 0) });
    averageBountyByCurrency.push({ currency, average: sorted.reduce((s, a) => s + a, 0) / sorted.length });
    const mid = Math.floor(sorted.length / 2);
    medianBountyByCurrency.push({ currency, median: sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]! });
    largestBountyByCurrency.push({ currency, amount: sorted[sorted.length - 1]! });
  }

  return {
    programId,
    programName: program?.name ?? "unknown",
    reports,
    accepted,
    paidCount: paid.length,
    paidRevenueByCurrency,
    averageBountyByCurrency,
    medianBountyByCurrency,
    largestBountyByCurrency,
  };
}

// --- v0.3.2: Program Candidate Discovery (single source of truth for both
// Telegram and the web dashboard — section 22). Thin wrappers over
// domain/programCandidates.ts; no calculation logic lives here twice. ---

/** All non-cancelled candidates, most-recently-discovered first (or filtered by stage). */
export function getProgramCandidates(stage?: ProgramCandidate["stage"]): ProgramCandidate[] {
  return listCandidates(stage ? { stage } : {});
}

export interface ProgramComparison {
  candidateCount: number;
  ranked: ScoredCandidate[];
}

/** Section 10/11: every eligible candidate, scored and ranked — never sorted by reward alone. */
export function getProgramComparison(): ProgramComparison {
  const candidates = listCandidates();
  return { candidateCount: candidates.length, ranked: compareCandidates(candidates) };
}

export interface EnrollmentStatus {
  candidate: ProgramCandidate;
  enrollmentComplete: boolean; // every checklist item checked
  authorizationConfirmed: boolean;
  liveTestingBlocked: boolean; // section 19 — true until 'ready_for_research' with a linked live Program
}

/** Section 21: the same "Enrollment: PENDING / Authorization: NOT CONFIRMED" shape used by /programs and /status in Telegram. */
export function getEnrollmentStatus(candidateId: string): EnrollmentStatus | null {
  const candidate = listCandidates({ includeCancelled: true }).find((c) => c.id === candidateId);
  if (!candidate) return null;
  return {
    candidate,
    enrollmentComplete: candidate.enrollmentChecklist.length > 0 && candidate.enrollmentChecklist.every((i) => i.done),
    authorizationConfirmed: candidate.authorizationConfirmedAt !== null,
    liveTestingBlocked: candidate.stage !== "ready_for_research" || candidate.linkedProgramId === null,
  };
}

/** The single candidate currently past [Select] and not yet cancelled — null if nothing has been selected yet. */
export function getSelectedProgram(): ProgramCandidate | null {
  const selected = listCandidates().filter((c) => c.selectedAt !== null);
  return selected[0] ?? null; // listCandidates() is already most-recent-first
}

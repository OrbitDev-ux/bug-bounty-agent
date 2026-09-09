// Agent performance metrics (project brief sections 38-39). Candidate counts
// are tracked separately from revenue on purpose — section 38 is explicit
// that "candidate count != revenue," and revenue here is always the
// paid-only figure from earnings.summarizeEarnings(), never awarded/
// simulated/pending (section 45).

import { listTasks } from "../domain/tasks.js";
import { listResearchSessions } from "../domain/researchSessions.js";
import { listFindings } from "../domain/findings.js";
import { listApprovals } from "../domain/approvals.js";
import { listReports } from "../domain/reports.js";
import { summarizeEarnings, listEarnings } from "../domain/earnings.js";
import { listRuns } from "../domain/agentRuns.js";

export interface AgentMetrics {
  tasksRun: number;
  researchSessions: number;
  candidateFindings: number;
  approvedFindings: number;
  reportsDrafted: number;
  accepted: number;
  paid: number;
  /** USD, paid-only. */
  revenue: number;
}

export function getMetrics(): AgentMetrics {
  const tasks = listTasks();
  const findings = listFindings();
  const approvals = listApprovals();
  const earnings = summarizeEarnings();

  return {
    tasksRun: tasks.filter((t) => t.status === "completed" || t.status === "failed").length,
    researchSessions: listResearchSessions().length,
    candidateFindings: findings.filter((f) => f.status === "candidate").length,
    approvedFindings: approvals.filter((a) => a.status === "approved" && a.findingId).length,
    reportsDrafted: listReports().length,
    accepted: findings.filter((f) => f.status === "accepted").length,
    // Bounty state lives on the Earning ledger, not Finding.bountyStatus —
    // that field is set at Finding creation ('not_applicable') and never
    // updated by the real pipeline (markAwarded/markPaid operate on
    // Earning rows). Counting from findings here would always read 0.
    paid: listEarnings().filter((e) => e.bountyStatus === "paid").length,
    revenue: earnings.allTime, // paid-only, per summarizeEarnings()
  };
}

export interface AgentROI {
  revenuePerSession: number | null;
  revenuePerTask: number | null;
  /** Only computed when there is real elapsed agent-run time to divide by — never fabricated. */
  revenuePerHour: number | null;
  totalTrackedHours: number;
}

/** Total wall-clock hours across completed agent_runs — the only source of "real time data" we have. */
function totalTrackedHours(): number {
  const runs = listRuns();
  let ms = 0;
  for (const r of runs) {
    if (r.finishedAt) {
      ms += new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
    }
  }
  return ms / (1000 * 60 * 60);
}

export function getROI(): AgentROI {
  const metrics = getMetrics();
  const hours = totalTrackedHours();

  return {
    revenuePerSession: metrics.researchSessions > 0 ? metrics.revenue / metrics.researchSessions : null,
    revenuePerTask: metrics.tasksRun > 0 ? metrics.revenue / metrics.tasksRun : null,
    revenuePerHour: hours > 0 ? metrics.revenue / hours : null,
    totalTrackedHours: hours,
  };
}

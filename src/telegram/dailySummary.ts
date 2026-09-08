import { listResearchSessions } from "../domain/researchSessions.js";
import { listFindings } from "../domain/findings.js";
import { listApprovals } from "../domain/approvals.js";
import { listReports } from "../domain/reports.js";
import { listTasks } from "../domain/tasks.js";
import { summarizeEarnings } from "../domain/earnings.js";

function isToday(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export interface DailySummary {
  researchSessionsToday: number;
  candidatesToday: number;
  approvalsApprovedToday: number;
  approvalsRejectedToday: number;
  approvalsPending: number;
  reportsDraftedToday: number;
  /** PAID only — never awarded/pending/simulated (section 45: no fake revenue). */
  bountiesPaidToday: number;
  currentQueueDepth: number;
}

/** Data for the Telegram daily report (project brief section 36). */
export function buildDailySummary(now: Date = new Date()): DailySummary {
  const researchSessionsToday = listResearchSessions().filter((s) => isToday(s.createdAt, now)).length;
  const candidatesToday = listFindings().filter((f) => f.status === "candidate" && isToday(f.createdAt, now)).length;

  const decidedToday = listApprovals().filter((a) => a.decidedAt && isToday(a.decidedAt, now));
  const approvalsApprovedToday = decidedToday.filter((a) => a.status === "approved").length;
  const approvalsRejectedToday = decidedToday.filter((a) => a.status === "rejected").length;

  const reportsDraftedToday = listReports().filter((r) => isToday(r.createdAt, now)).length;

  return {
    researchSessionsToday,
    candidatesToday,
    approvalsApprovedToday,
    approvalsRejectedToday,
    approvalsPending: listApprovals("pending").length,
    reportsDraftedToday,
    bountiesPaidToday: summarizeEarnings(now).today,
    currentQueueDepth: listTasks("queued").length,
  };
}

export function formatDailySummaryMessage(summary: DailySummary): string {
  return [
    "\u{1F4CA} DAILY AGENT REPORT",
    "",
    `Research Sessions:\n${summary.researchSessionsToday}`,
    "",
    `Candidates:\n${summary.candidatesToday}`,
    "",
    `Approvals:\n${summary.approvalsApprovedToday} approved, ${summary.approvalsRejectedToday} rejected, ${summary.approvalsPending} pending`,
    "",
    `Reports:\n${summary.reportsDraftedToday}`,
    "",
    `Bounties Paid:\n$${summary.bountiesPaidToday.toFixed(2)} (PAID only)`,
    "",
    `Current Queue:\n${summary.currentQueueDepth}`,
  ].join("\n");
}

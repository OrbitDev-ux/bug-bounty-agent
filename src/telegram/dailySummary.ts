import { listResearchSessions } from "../domain/researchSessions.js";
import { listFindings } from "../domain/findings.js";
import { listApprovals } from "../domain/approvals.js";
import { listReports } from "../domain/reports.js";
import { listTasks } from "../domain/tasks.js";
import { summarizeEarnings, summarizeEarningsByCurrency, listEarnings } from "../domain/earnings.js";
import { listPrograms } from "../domain/programs.js";
import { getProgramAnalytics } from "../services/dashboard.js";
import { getFindingProfitabilityByCategory } from "../services/analytics.js";

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

// --- Weekly summary (section 37) ---

function isWithinDays(iso: string, now: Date, days: number): boolean {
  const ageMs = now.getTime() - new Date(iso).getTime();
  return ageMs >= 0 && ageMs <= days * 24 * 60 * 60 * 1000;
}

function findTopProgramAndCategory(): { topProgram: string | null; topCategory: string | null } {
  let topProgram: string | null = null;
  let topProgramPaid = 0;
  for (const p of listPrograms()) {
    const a = getProgramAnalytics(p.id);
    if (a.paidCount > topProgramPaid) {
      topProgramPaid = a.paidCount;
      topProgram = p.name;
    }
  }
  const categories = getFindingProfitabilityByCategory();
  const topCategory = categories.length > 0 && categories[0]!.paidCount > 0 ? categories[0]!.category : null;
  return { topProgram, topCategory };
}

export interface WeeklySummary {
  tasksCompleted: number;
  researchSessions: number;
  candidates: number;
  reports: number;
  accepted: number;
  paidByCurrency: { currency: string; total: number }[];
  topProgram: string | null;
  topCategory: string | null;
}

/** Data for the Telegram weekly report (section 37). "Paid" is currency-correct — never blended. */
export function buildWeeklySummary(now: Date = new Date()): WeeklySummary {
  const tasksCompleted = listTasks("completed").filter((t) => isWithinDays(t.updatedAt, now, 7)).length;
  const researchSessions = listResearchSessions().filter((s) => isWithinDays(s.createdAt, now, 7)).length;
  const candidates = listFindings().filter((f) => isWithinDays(f.createdAt, now, 7)).length;
  const reports = listReports().filter((r) => isWithinDays(r.createdAt, now, 7)).length;
  const accepted = listFindings().filter((f) => f.acceptedAt && isWithinDays(f.acceptedAt, now, 7)).length;
  const paidByCurrency = summarizeEarningsByCurrency().map((b) => ({ currency: b.currency, total: b.paid })); // note: all-time paid per currency, since a 7-day paid-only cut is rarely meaningful at this scale
  const { topProgram, topCategory } = findTopProgramAndCategory();

  return { tasksCompleted, researchSessions, candidates, reports, accepted, paidByCurrency, topProgram, topCategory };
}

export function formatWeeklySummaryMessage(s: WeeklySummary): string {
  return [
    "\u{1F4C8} WEEKLY SUMMARY",
    "",
    `Tasks:\n${s.tasksCompleted}`,
    "",
    `Research Sessions:\n${s.researchSessions}`,
    "",
    `Candidates:\n${s.candidates}`,
    "",
    `Reports:\n${s.reports}`,
    "",
    `Accepted:\n${s.accepted}`,
    "",
    `Paid (all time, PAID only):\n${s.paidByCurrency.map((b) => `${b.total.toFixed(2)} ${b.currency}`).join(", ") || "$0"}`,
    "",
    `Top Program:\n${s.topProgram ?? "n/a"}`,
    "",
    `Top Finding Category:\n${s.topCategory ?? "n/a"}`,
  ].join("\n");
}

// --- Monthly summary (section 38) ---

export interface MonthlySummary {
  paidThisMonth: number; // nominal, matches summarizeEarnings() convention used elsewhere
  pendingByCurrency: { currency: string; total: number }[];
  awardedByCurrency: { currency: string; total: number }[];
  paidByCurrency: { currency: string; total: number }[];
  reports: number;
  accepted: number;
  paidCount: number;
  averagePaidBountyByCurrency: { currency: string; average: number }[];
}

export function buildMonthlySummary(): MonthlySummary {
  const s = summarizeEarnings();
  const byCurrency = summarizeEarningsByCurrency();
  const findings = listFindings();

  const paidEarnings = listEarnings().filter((e) => e.bountyStatus === "paid" && e.amount !== null);
  const sumsByCurrency = new Map<string, { total: number; count: number }>();
  for (const e of paidEarnings) {
    const currency = e.currency ?? "UNSET";
    const entry = sumsByCurrency.get(currency) ?? { total: 0, count: 0 };
    entry.total += e.amount!;
    entry.count += 1;
    sumsByCurrency.set(currency, entry);
  }
  const averagePaidBountyByCurrency = [...sumsByCurrency.entries()].map(([currency, { total, count }]) => ({ currency, average: total / count }));

  return {
    paidThisMonth: s.thisMonth,
    pendingByCurrency: byCurrency.map((b) => ({ currency: b.currency, total: b.pending })),
    awardedByCurrency: byCurrency.map((b) => ({ currency: b.currency, total: b.awarded })),
    paidByCurrency: byCurrency.map((b) => ({ currency: b.currency, total: b.paid })),
    reports: listReports().length,
    accepted: findings.filter((f) => f.acceptedAt !== null).length,
    // Bounty state lives on the Earning ledger, not Finding.bountyStatus —
    // see the same fix in src/services/metrics.ts and src/telegram/views.ts.
    paidCount: paidEarnings.length,
    averagePaidBountyByCurrency,
  };
}

export function formatMonthlySummaryMessage(s: MonthlySummary): string {
  return [
    "\u{1F4CA} MONTHLY REVENUE",
    "",
    `Paid:\n${s.paidByCurrency.map((b) => `${b.total.toFixed(2)} ${b.currency}`).join(", ") || "$0"}`,
    "",
    `Awarded:\n${s.awardedByCurrency.map((b) => `${b.total.toFixed(2)} ${b.currency}`).join(", ") || "$0"}`,
    "",
    `Pending:\n${s.pendingByCurrency.map((b) => `${b.total.toFixed(2)} ${b.currency}`).join(", ") || "$0"}`,
    "",
    `Reports:\n${s.reports}`,
    "",
    `Accepted:\n${s.accepted}`,
    "",
    `Paid:\n${s.paidCount}`,
    "",
    `Average Paid Bounty:\n${s.averagePaidBountyByCurrency.map((b) => `${b.average.toFixed(2)} ${b.currency}`).join(", ") || "n/a"}`,
  ].join("\n");
}

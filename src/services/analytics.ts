// Revenue Intelligence analytics (project brief v0.3.1 sections 23-30, 41-43).
// Single source of truth for both the Telegram /analytics command and the
// web dashboard (section 44) — neither computes its own numbers, both call
// these functions.

import { listFindings } from "../domain/findings.js";
import { listEarnings } from "../domain/earnings.js";
import { listReports } from "../domain/reports.js";
import { listResearchSessions } from "../domain/researchSessions.js";
import { summarizeCostsByCurrency, summarizeCostsByCurrencySince, listCosts } from "../domain/costs.js";
import { getRevenueTimelineForWindow, type TimelineWindow } from "./dashboard.js";
import type { Finding } from "../domain/types.js";

export interface FunnelMetrics {
  research: number;
  candidates: number;
  reports: number;
  submitted: number;
  accepted: number;
  awarded: number;
  paid: number;
}

/**
 * Research -> Candidate -> Report -> Submitted -> Accepted -> Awarded -> Paid
 * (section 27). "candidates" counts all findings — in this codebase every
 * created Finding is transitioned to 'candidate' immediately by its only
 * production caller (createCandidateFindings), so total finding count is an
 * accurate proxy, not an estimate. "reports"/"submitted"/"accepted"/
 * "awarded"/"paid" are exact counts from real stamped state (a Report row
 * only exists once drafted; submittedAt/acceptedAt are stamped once;
 * awardedAt/paid status come from the earnings ledger).
 */
export function getFunnelMetrics(): FunnelMetrics {
  const findings = listFindings();
  const earnings = listEarnings();
  return {
    research: listResearchSessions().length,
    candidates: findings.length,
    reports: listReports().length,
    submitted: findings.filter((f) => f.submittedAt !== null).length,
    accepted: findings.filter((f) => f.acceptedAt !== null).length,
    awarded: earnings.filter((e) => e.awardedAt !== null).length,
    paid: earnings.filter((e) => e.bountyStatus === "paid").length,
  };
}

export interface ConversionRates {
  candidateToReport: number | null;
  reportToAccepted: number | null;
  acceptedToAwarded: number | null;
  awardedToPaid: number | null;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null; // section 28: N/A, never a fabricated 0% or divide-by-zero
  return numerator / denominator;
}

/** Each stage's conversion rate, N/A (null) when the denominator is zero (section 28). */
export function getConversionRates(): ConversionRates {
  const f = getFunnelMetrics();
  return {
    candidateToReport: rate(f.reports, f.candidates),
    reportToAccepted: rate(f.accepted, f.reports),
    acceptedToAwarded: rate(f.awarded, f.accepted),
    awardedToPaid: rate(f.paid, f.awarded),
  };
}

export interface CategoryProfitability {
  category: string;
  reports: number;
  accepted: number;
  paidCount: number;
  paidRevenueByCurrency: { currency: string; total: number }[];
  averageBountyByCurrency: { currency: string; average: number }[];
}

/** Per-category (section 26) breakdown, currency-correct throughout — never averaged across currencies. */
export function getFindingProfitabilityByCategory(): CategoryProfitability[] {
  const findings = listFindings();
  const earnings = listEarnings();
  const byCategory = new Map<string, Finding[]>();
  for (const f of findings) {
    const cat = f.category ?? "Uncategorized";
    const list = byCategory.get(cat) ?? [];
    list.push(f);
    byCategory.set(cat, list);
  }

  const results: CategoryProfitability[] = [];
  for (const [category, categoryFindings] of byCategory) {
    const findingIds = new Set(categoryFindings.map((f) => f.id));
    const reports = categoryFindings.filter((f) => f.submittedAt !== null || f.status === "report_draft" || f.status === "submitted" || f.status === "triaged" || f.status === "accepted").length;
    const accepted = categoryFindings.filter((f) => f.acceptedAt !== null).length;
    const paidEarnings = earnings.filter((e) => e.bountyStatus === "paid" && findingIds.has(e.findingId) && e.amount !== null);

    const byCurrency = new Map<string, number[]>();
    for (const e of paidEarnings) {
      const list = byCurrency.get(e.currency ?? "UNSET") ?? [];
      list.push(e.amount!);
      byCurrency.set(e.currency ?? "UNSET", list);
    }

    const paidRevenueByCurrency = [...byCurrency.entries()].map(([currency, amounts]) => ({ currency, total: amounts.reduce((s, a) => s + a, 0) }));
    const averageBountyByCurrency = [...byCurrency.entries()].map(([currency, amounts]) => ({ currency, average: amounts.reduce((s, a) => s + a, 0) / amounts.length }));

    results.push({ category, reports, accepted, paidCount: paidEarnings.length, paidRevenueByCurrency, averageBountyByCurrency });
  }

  return results.sort((a, b) => b.paidCount - a.paidCount);
}

export interface TimeToBountyStats {
  submissionToAcceptedAvgHours: number | null;
  acceptedToAwardedAvgHours: number | null;
  awardedToPaidAvgHours: number | null;
  submissionToPaidAvgHours: number | null;
  sampleSizes: { submissionToAccepted: number; acceptedToAwarded: number; awardedToPaid: number; submissionToPaid: number };
}

function avgHoursBetween(pairs: [string, string][]): number | null {
  if (pairs.length === 0) return null;
  const totalHours = pairs.reduce((sum, [start, end]) => sum + (new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60), 0);
  return totalHours / pairs.length;
}

/**
 * Time-to-bounty (section 30) — only ever computed from real stamped
 * timestamps (finding.submittedAt/acceptedAt, earning.awardedAt/paidAt).
 * A stage with no completed pairs returns null ("not computed"), never an
 * estimate.
 */
export function getTimeToBounty(): TimeToBountyStats {
  const findings = listFindings();
  const earnings = listEarnings();
  const findingById = new Map(findings.map((f) => [f.id, f]));

  const submissionToAccepted: [string, string][] = findings.filter((f) => f.submittedAt && f.acceptedAt).map((f) => [f.submittedAt!, f.acceptedAt!]);

  const acceptedToAwarded: [string, string][] = [];
  const awardedToPaid: [string, string][] = [];
  const submissionToPaid: [string, string][] = [];

  for (const e of earnings) {
    const finding = findingById.get(e.findingId);
    if (e.awardedAt && finding?.acceptedAt) acceptedToAwarded.push([finding.acceptedAt, e.awardedAt]);
    if (e.awardedAt && e.paidAt) awardedToPaid.push([e.awardedAt, e.paidAt]);
    if (finding?.submittedAt && e.paidAt) submissionToPaid.push([finding.submittedAt, e.paidAt]);
  }

  return {
    submissionToAcceptedAvgHours: avgHoursBetween(submissionToAccepted),
    acceptedToAwardedAvgHours: avgHoursBetween(acceptedToAwarded),
    awardedToPaidAvgHours: avgHoursBetween(awardedToPaid),
    submissionToPaidAvgHours: avgHoursBetween(submissionToPaid),
    sampleSizes: {
      submissionToAccepted: submissionToAccepted.length,
      acceptedToAwarded: acceptedToAwarded.length,
      awardedToPaid: awardedToPaid.length,
      submissionToPaid: submissionToPaid.length,
    },
  };
}

export interface NetRevenuePoint {
  currency: string;
  grossPaid: number;
  /** null = NOT AVAILABLE — no cost tracking has ever been recorded, so we refuse to assume zero cost (section 41). */
  trackedCosts: number | null;
  net: number | null;
}

/**
 * Net Revenue = Gross (Paid) - Tracked Costs, per currency, for a window.
 * If cost tracking has NEVER been used at all (not just "zero this period"),
 * every currency's net comes back NOT AVAILABLE rather than silently
 * assuming zero cost — see the module-level rationale in recordCost()'s
 * callers (src/services/costTracking.ts records real Claude spend
 * automatically, so in practice this is only null before the very first
 * tracked call).
 */
export function getNetRevenue(window: TimelineWindow): NetRevenuePoint[] {
  const hasAnyCostTracking = listCosts().length > 0;
  const timeline = getRevenueTimelineForWindow(window);
  const grossByCurrency = new Map<string, number>();
  for (const point of timeline) grossByCurrency.set(point.currency, (grossByCurrency.get(point.currency) ?? 0) + point.amount);

  const windowStart = windowStartIso(window);
  const costs = windowStart ? summarizeCostsByCurrencySince(windowStart) : summarizeCostsByCurrency();
  const costByCurrency = new Map(costs.map((c) => [c.currency, c.total]));

  const currencies = new Set([...grossByCurrency.keys(), ...costByCurrency.keys()]);
  return [...currencies].map((currency) => {
    const grossPaid = grossByCurrency.get(currency) ?? 0;
    const trackedCosts = hasAnyCostTracking ? (costByCurrency.get(currency) ?? 0) : null;
    return { currency, grossPaid, trackedCosts, net: trackedCosts === null ? null : grossPaid - trackedCosts };
  });
}

function windowStartIso(window: TimelineWindow, now: Date = new Date()): string | null {
  if (window === "all") return null;
  if (window === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const days = window === "7d" ? 7 : window === "30d" ? 30 : 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export interface ProgramRevenuePerHour {
  programId: string;
  /** Only counts completed research sessions with real elapsed time — never fabricated. Null if no completed sessions exist. */
  revenuePerHourByCurrency: { currency: string; perHour: number }[] | null;
  totalTrackedHours: number;
}

/** Revenue / research-time for one program (section 25) — uses real session durations (createdAt -> updatedAt on completion), never estimated. */
export function getProgramRevenuePerHour(programId: string): ProgramRevenuePerHour {
  const sessions = listResearchSessions().filter((s) => s.programId === programId && s.status !== "running");
  const totalHours = sessions.reduce((sum, s) => sum + (new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime()) / (1000 * 60 * 60), 0);

  if (totalHours <= 0) {
    return { programId, revenuePerHourByCurrency: null, totalTrackedHours: 0 };
  }

  const earnings = listEarnings().filter((e) => e.programId === programId && e.bountyStatus === "paid" && e.amount !== null);
  const byCurrency = new Map<string, number>();
  for (const e of earnings) byCurrency.set(e.currency ?? "UNSET", (byCurrency.get(e.currency ?? "UNSET") ?? 0) + e.amount!);

  return {
    programId,
    revenuePerHourByCurrency: [...byCurrency.entries()].map(([currency, total]) => ({ currency, perHour: total / totalHours })),
    totalTrackedHours: totalHours,
  };
}

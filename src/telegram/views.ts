// Pure text/keyboard formatting for the Telegram Control Center (v0.3.1).
// Kept separate from bot.ts so these are directly unit-testable without a
// live bot connection — same pattern as approvalMessage.ts.

import { InlineKeyboard } from "grammy";
import { isStale } from "../domain/scope.js";
import type { Program, Finding, Task, FindingStatus } from "../domain/types.js";
import { getFunnelMetrics, getConversionRates, getFindingProfitabilityByCategory } from "../services/analytics.js";
import { listPrograms } from "../domain/programs.js";
import { getProgramAnalytics, type TimelineWindow } from "../services/dashboard.js";
import { summarizeEarningsByCurrency, listEarnings } from "../domain/earnings.js";
import type { GoalProgress } from "../domain/goals.js";
import { needsReverification, type ScoredCandidate } from "../domain/programCandidates.js";
import type { EnrollmentStatus } from "../services/dashboard.js";
import type { ProgramCandidate, ProgramCandidateStage } from "../domain/types.js";

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Chat", "menu:chat")
    .text("🔎 Research", "menu:research")
    .text("🔐 Approvals", "menu:approvals")
    .row()
    .text("📋 Tasks", "menu:tasks")
    .text("🐛 Findings", "menu:findings")
    .text("🌐 Programs", "menu:programs")
    .row()
    .text("💰 Earnings", "menu:earnings")
    .text("📊 Analytics", "menu:analytics")
    .row()
    .text("⚙️ Settings", "menu:settings")
    .text("🤖 Agent Status", "menu:status");
}

export function mainMenuText(): string {
  return "🤖 Bug Bounty Agent\n\nPick something below, or just message me (use /chat first for agent-aware conversation).";
}

// --- Findings (section 14-15) ---

const FINDING_FILTERS = ["all", "new", "candidate", "submitted", "accepted", "paid", "duplicate", "invalid"] as const;
export type FindingFilter = (typeof FINDING_FILTERS)[number];

export function findingsFilterKeyboard(active: FindingFilter): InlineKeyboard {
  const kb = new InlineKeyboard();
  FINDING_FILTERS.forEach((f, i) => {
    kb.text(f === active ? `• ${f}` : f, `findings:filter:${f}`);
    if ((i + 1) % 4 === 0) kb.row();
  });
  return kb;
}

function matchesFindingFilter(f: Finding, filter: FindingFilter, paidFindingIds: Set<string>): boolean {
  if (filter === "all") return true;
  if (filter === "new") return f.status === "discovered";
  // Bounty state lives on the Earning ledger, not Finding.bountyStatus —
  // that field is never updated by the real pipeline (markAwarded/markPaid
  // operate on Earning rows). See src/services/metrics.ts for the same fix.
  if (filter === "paid") return paidFindingIds.has(f.id);
  return f.status === (filter as FindingStatus);
}

function getPaidFindingIds(): Set<string> {
  return new Set(listEarnings().filter((e) => e.bountyStatus === "paid").map((e) => e.findingId));
}

export function formatFindingsList(findings: Finding[], filter: FindingFilter, page: number, pageSize = 8): { text: string; totalPages: number } {
  const paidFindingIds = filter === "paid" ? getPaidFindingIds() : new Set<string>();
  const filtered = findings.filter((f) => matchesFindingFilter(f, filter, paidFindingIds));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = filtered.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  const lines = [`🐛 FINDINGS (${filter}, ${filtered.length})`, ""];
  if (slice.length === 0) lines.push("No findings match this filter.");
  for (const f of slice) lines.push(`#${f.id.slice(0, 8)} ${f.title} — ${f.status.toUpperCase()}`);
  return { text: lines.join("\n"), totalPages };
}

export function findingsPaginationKeyboard(filter: FindingFilter, page: number, totalPages: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (page > 0) kb.text("⬅️ Prev", `findings:page:${page - 1}:${filter}`);
  kb.text(`${page + 1}/${totalPages}`, "noop");
  if (page < totalPages - 1) kb.text("Next ➡️", `findings:page:${page + 1}:${filter}`);
  return kb;
}

export function formatFindingDetail(f: Finding, programName: string): string {
  return [
    `🐛 Finding #${f.id.slice(0, 8)}`,
    "",
    `Program:\n${programName}`,
    "",
    `Target:\n${f.asset}`,
    "",
    `Category:\n${f.category ?? "unknown"}`,
    "",
    `Confidence:\n${f.confidence !== null ? (f.confidence >= 0.7 ? "HIGH" : f.confidence >= 0.4 ? "MEDIUM" : "LOW") : "n/a"}`,
    "",
    `Status:\n${f.status.toUpperCase()}`,
    "",
    `Duplicate Risk:\n${f.duplicateVerdict ?? "n/a"}`,
  ].join("\n");
}

// --- Programs (section 16-17) ---

export function formatProgramsList(programs: Program[]): string {
  const lines = ["🌐 PROGRAMS", ""];
  for (const p of programs) {
    lines.push(p.name);
    if (!p.policy.automationAllowed) {
      lines.push("Automation: ❌");
    } else if (!p.policyLastVerifiedAt) {
      lines.push("Scope: ⚠️ Never verified");
    } else if (isStale(p.policyLastVerifiedAt)) {
      lines.push("Scope: ⚠️ Reverification Required");
    } else {
      lines.push("Scope: ✅");
    }
    lines.push("");
  }
  if (programs.length === 0) lines.push("No programs yet.");
  return lines.join("\n").trimEnd();
}

export function formatProgramDetail(program: Program): string {
  const analytics = getProgramAnalytics(program.id);
  const revenueLines = analytics.paidRevenueByCurrency.map((r) => `${r.total} ${r.currency}`);
  return [
    `🌐 ${program.name}`,
    "",
    `Official URL:\n${program.url}`,
    "",
    `Automation Policy:\n${program.policy.automationAllowed ? "✅ Allowed" : "❌ Not allowed"}`,
    "",
    `Last Verified:\n${program.policyLastVerifiedAt ?? "never"}`,
    "",
    `Reports:\n${analytics.reports}`,
    "",
    `Accepted:\n${analytics.accepted}`,
    "",
    `Paid Revenue:\n${revenueLines.join(", ") || "$0"}`,
  ].join("\n");
}

// --- Earnings periods (section 21) ---

export const EARNINGS_PERIODS = ["today", "week", "month", "lastmonth", "90d", "all"] as const;
export type EarningsPeriod = (typeof EARNINGS_PERIODS)[number];

export function earningsPeriodToWindow(period: EarningsPeriod): TimelineWindow {
  if (period === "today") return "today";
  if (period === "week") return "7d";
  if (period === "90d") return "90d";
  if (period === "all") return "all";
  return "30d"; // month, lastmonth both approximate to a 30d window for the timeline (see formatEarnings note)
}

export function earningsPeriodKeyboard(active: EarningsPeriod): InlineKeyboard {
  const kb = new InlineKeyboard();
  EARNINGS_PERIODS.forEach((p, i) => {
    kb.text(p === active ? `• ${p}` : p, `earnings:period:${p}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  return kb;
}

export function formatEarnings(period: EarningsPeriod): string {
  const byCurrency = summarizeEarningsByCurrency();
  const lines = ["💰 EARNINGS", ""];
  if (byCurrency.length === 0) {
    lines.push("No earnings recorded yet.");
    return lines.join("\n");
  }
  for (const b of byCurrency) {
    lines.push(`${b.currency}`, `Paid: ${b.paid.toFixed(2)}`, `Awarded: ${b.awarded.toFixed(2)}`, `Pending: ${b.pending.toFixed(2)}`, "");
  }
  lines.push(`Confirmed Revenue = PAID only. Period: ${period}.`);
  return lines.join("\n");
}

// --- Analytics (section 23) ---

export function formatAnalytics(): string {
  const funnel = getFunnelMetrics();
  const rates = getConversionRates();
  const byCategory = getFindingProfitabilityByCategory();
  const topCategory = byCategory[0];

  const programs = listPrograms();
  let topProgram: { name: string; paidCount: number } | null = null;
  for (const p of programs) {
    const a = getProgramAnalytics(p.id);
    if (!topProgram || a.paidCount > topProgram.paidCount) topProgram = { name: p.name, paidCount: a.paidCount };
  }

  const pct = (r: number | null) => (r === null ? "N/A" : `${(r * 100).toFixed(1)}%`);
  // "Acceptance"/"Paid Rate" are both measured against reports, matching the
  // project brief's own illustrative example numbers (24 reports, 7
  // accepted, 4 paid -> 29.2% / 16.7%).
  const acceptance = rate(funnel.accepted, funnel.reports);
  const paidRate = rate(funnel.paid, funnel.reports);

  return [
    "📊 ANALYTICS",
    "",
    `Reports:\n${funnel.reports}`,
    "",
    `Accepted:\n${funnel.accepted}`,
    "",
    `Paid:\n${funnel.paid}`,
    "",
    `Acceptance:\n${pct(acceptance)}`,
    "",
    `Paid Rate:\n${pct(paidRate)}`,
    "",
    `Top Program:\n${topProgram && topProgram.paidCount > 0 ? topProgram.name : "n/a"}`,
    "",
    `Top Category:\n${topCategory && topCategory.paidCount > 0 ? topCategory.category : "n/a"}`,
    "",
    `Candidate→Report: ${pct(rates.candidateToReport)}  Report→Accepted: ${pct(rates.reportToAccepted)}`,
    `Accepted→Awarded: ${pct(rates.acceptedToAwarded)}  Awarded→Paid: ${pct(rates.awardedToPaid)}`,
  ].join("\n");
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

// --- Goals (section 32) ---

export function formatGoalsList(goals: GoalProgress[]): string {
  const lines = ["🎯 GOALS", ""];
  if (goals.length === 0) {
    lines.push("No goals set. Use `bba earnings goal-add` on the CLI, or ask in /chat.");
    return lines.join("\n");
  }
  for (const g of goals) {
    lines.push(g.goal.name, `${Math.round(g.progressRatio * 100)}%`, "");
  }
  return lines.join("\n").trimEnd();
}

export function formatGoalDetail(g: GoalProgress): string {
  return [
    `🎯 ${g.goal.name}`,
    "",
    `Paid:\n${g.paidInGoalCurrency} ${g.goal.targetCurrency}`,
    "",
    `Target:\n${g.goal.targetAmount} ${g.goal.targetCurrency}`,
    "",
    `Progress:\n${(g.progressRatio * 100).toFixed(1)}%`,
  ].join("\n");
}

// --- Program Candidate Discovery / Enrollment Preparation (v0.3.2) ---

const STAGE_LABEL: Record<ProgramCandidateStage, string> = {
  discovered: "DISCOVERED",
  researched: "RESEARCHED",
  candidate: "CANDIDATE",
  enrollment_pending: "ENROLLMENT PENDING",
  authorized: "AUTHORIZED",
  ready_for_research: "READY FOR RESEARCH",
};

function checkOrCross(v: boolean): string {
  return v ? "✅" : "❌";
}

export function formatCandidatesList(candidates: ProgramCandidate[]): string {
  const lines = ["🔎 PROGRAM CANDIDATES", "", `Candidates:\n${candidates.length}`, ""];
  if (candidates.length === 0) {
    lines.push('None yet. Try /discover "<topic>" first.');
    return lines.join("\n");
  }
  for (const c of candidates) {
    lines.push(`#${c.id.slice(0, 8)} ${c.name} (${c.platform}) — ${STAGE_LABEL[c.stage]}`);
  }
  return lines.join("\n");
}

export function formatCandidateDetail(candidate: ProgramCandidate): string {
  const e = candidate.eligibility;
  return [
    `🔎 ${candidate.name}`,
    "",
    `Platform:\n${candidate.platform}`,
    "",
    `Stage:\n${STAGE_LABEL[candidate.stage]}`,
    "",
    `Public:\n${candidate.publicOrPrivate === "public" ? "✅" : candidate.publicOrPrivate === "private" ? "❌ Private" : "❓ UNKNOWN"}`,
    "",
    `Scope Clarity:\n${candidate.scopeClarity}${candidate.scopeSummary ? `\n${candidate.scopeSummary}` : ""}`,
    "",
    `Policy Clarity:\n${candidate.policyClarity}${candidate.policySummary ? `\n${candidate.policySummary}` : ""}`,
    "",
    `Automation Policy:\n${candidate.automationPolicy.toUpperCase()}${candidate.automationPolicy === "unknown" ? " (never treated as allowed)" : ""}`,
    "",
    `Reward Transparency:\n${candidate.rewardTransparency}${candidate.rewardSummary ? `\n${candidate.rewardSummary}` : ""}`,
    "",
    "Eligibility:",
    `  Public program: ${e.publicProgram}`,
    `  Registration required: ${e.registrationRequired}`,
    `  Age/eligibility restrictions: ${e.ageOrEligibilityRestrictions}`,
    `  Geographic restrictions: ${e.geographicRestrictions}`,
    `  Account required: ${e.accountRequired}`,
    `  Terms acceptance required: ${e.termsAcceptanceRequired}`,
    e.notes ? `  Notes: ${e.notes}` : "",
    "",
    `Risks:\n${candidate.risks || "None noted."}`,
    "",
    `Enrollment Requirements:\n${candidate.enrollmentRequirements || "Not yet researched."}`,
    "",
    `Sources:\n${candidate.sources.length}`,
    candidate.policyLastVerifiedAt && needsReverification(candidate) ? "\n⚠️ REVERIFICATION_REQUIRED — policy last verified over 90 days ago." : "",
    "",
    `Official URL:\n${candidate.officialUrl}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function formatCandidateRecommendation(candidateCount: number, ranked: ScoredCandidate[]): string {
  const recommended = ranked[0];
  const alternatives = ranked.slice(1, 3);
  const lines = ["🔎 PROGRAM RESEARCH", "", `Candidates:\n${candidateCount}`, ""];
  if (!recommended) {
    lines.push("No candidates researched yet.");
    return lines.join("\n");
  }
  const c = recommended.candidate;
  lines.push(
    `Recommended:\n${c.name}`,
    "",
    `Platform:\n${c.platform}`,
    "",
    `Public:\n${checkOrCross(c.publicOrPrivate === "public")}`,
    "",
    `Scope Clarity:\n${c.scopeClarity}`,
    "",
    `Automation Policy:\n${c.automationPolicy.toUpperCase()}`,
    "",
    `Reward Transparency:\n${c.rewardTransparency}`,
    "",
    `Score:\n${recommended.score}/100 (decision support only, not a success/revenue guarantee)`,
    `Why:\n${recommended.reason}`,
    "",
  );
  if (alternatives.length > 0) {
    lines.push("Alternatives:");
    for (const alt of alternatives) lines.push(`  ${alt.candidate.name} — ${alt.score}/100`);
  }
  return lines.join("\n");
}

export function formatCandidateComparison(ranked: ScoredCandidate[]): string {
  const lines = ["📊 PROGRAM COMPARISON", ""];
  if (ranked.length === 0) {
    lines.push("No candidates to compare yet.");
    return lines.join("\n");
  }
  ranked.forEach((r, i) => {
    const c = r.candidate;
    lines.push(
      `${i + 1}. ${c.name} (${c.platform}) — ${r.score}/100`,
      `   Scope:${c.scopeClarity} Policy:${c.policyClarity} Automation:${c.automationPolicy} Reward:${c.rewardTransparency} Public:${c.publicOrPrivate}`,
      "",
    );
  });
  return lines.join("\n").trimEnd();
}

/**
 * Stage-aware action keyboard for /candidate and candidate:details — every
 * action reachable at that stage is one tap away, so nothing about this
 * pipeline requires falling back to the CLI. The one deliberate exception:
 * activating a candidate into a real, live-testable program still requires
 * a Confirm tap (candidate:activate-confirm), matching the same
 * confirm-before-executing pattern used for CONTROL_AGENT_PAUSE/RESUME —
 * this is the single highest-consequence action in the whole feature.
 */
export function candidateActionKeyboard(candidate: ProgramCandidate): InlineKeyboard {
  const kb = new InlineKeyboard();
  switch (candidate.stage) {
    case "discovered":
    case "researched":
      kb.text("🔬 Research", `candidate:research:${candidate.id}`).text("❌ Cancel", `candidate:cancel:${candidate.id}`);
      break;
    case "candidate":
      kb.text("📄 Details", `candidate:details:${candidate.id}`)
        .text("📊 Compare", "candidate:compare")
        .row()
        .text("✅ Select", `candidate:select:${candidate.id}`)
        .text("❌ Cancel", `candidate:cancel:${candidate.id}`);
      break;
    case "enrollment_pending":
      kb.text("📋 View Checklist", `candidate:viewchecklist:${candidate.id}`).text("❌ Cancel", `candidate:cancel:${candidate.id}`);
      break;
    case "authorized":
      kb.text("🚀 Activate for Live Research", `candidate:activate:${candidate.id}`).row().text("❌ Cancel", `candidate:cancel:${candidate.id}`);
      break;
    case "ready_for_research":
      kb.text(`✅ Live: ${candidate.linkedProgramId?.slice(0, 8) ?? "linked program"}`, "noop");
      break;
  }
  return kb;
}

export function candidateActivateConfirmKeyboard(candidateId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm Activate", `candidate:activate-confirm:${candidateId}`)
    .text("❌ Cancel", `candidate:activate-cancel:${candidateId}`);
}

export function formatEnrollmentChecklist(candidate: ProgramCandidate): string {
  const lines = [`📋 ENROLLMENT CHECKLIST`, "", candidate.name, ""];
  for (const item of candidate.enrollmentChecklist) {
    lines.push(`[${item.done ? "x" : " "}] ${item.item}`);
  }
  lines.push(
    "",
    "The agent will never create this account or accept these terms for you — HUMAN ACTION REQUIRED for every item above.",
    "",
    "Once you've actually enrolled, tap \"I have enrolled\" below. This records your self-report — it is not independently verified against the platform.",
  );
  return lines.join("\n");
}

export function enrollmentChecklistKeyboard(candidate: ProgramCandidate): InlineKeyboard {
  const kb = new InlineKeyboard();
  candidate.enrollmentChecklist.forEach((item, i) => {
    kb.text(`${item.done ? "☑" : "☐"} ${item.item}`.slice(0, 60), `candidate:checklist:${candidate.id}:${i}`).row();
  });
  kb.text("✅ I have enrolled", `candidate:authorize:${candidate.id}`);
  return kb;
}

export function formatEnrollmentStatus(status: EnrollmentStatus): string {
  return [
    `Program:\n${status.candidate.name}`,
    "",
    `Enrollment:\n${status.enrollmentComplete ? "CONFIRMED" : "PENDING"}`,
    "",
    `Authorization:\n${status.authorizationConfirmed ? "CONFIRMED (self-reported)" : "NOT CONFIRMED"}`,
    "",
    `Live Testing:\n${status.liveTestingBlocked ? "BLOCKED" : "UNBLOCKED"}`,
  ].join("\n");
}

// --- Tasks (section 13) ---

export function formatTasksList(tasks: Task[]): string {
  const lines = ["📋 TASK QUEUE", ""];
  if (tasks.length === 0) lines.push("No tasks.");
  for (const t of tasks.slice(0, 15)) lines.push(`#${t.id.slice(0, 8)} ${t.type.padEnd(10)} ${t.status.toUpperCase()}`);
  return lines.join("\n");
}

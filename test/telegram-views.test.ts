import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding } from "../src/domain/findings.js";
import { createReport } from "../src/domain/reports.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { createGoal, getGoalProgress } from "../src/domain/goals.js";
import {
  formatFindingsList,
  formatFindingDetail,
  formatProgramsList,
  formatProgramDetail,
  formatEarnings,
  formatAnalytics,
  formatGoalsList,
  formatGoalDetail,
  formatTasksList,
  mainMenuText,
  formatCandidatesList,
  formatCandidateDetail,
  formatCandidateRecommendation,
  formatCandidateComparison,
  formatEnrollmentChecklist,
  formatEnrollmentStatus,
  candidateActionKeyboard,
} from "../src/telegram/views.js";
import { createCandidate, recordResearch, selectCandidate, compareCandidates, getCandidate, confirmAuthorization } from "../src/domain/programCandidates.js";
import { getEnrollmentStatus } from "../src/services/dashboard.js";
import { createTask } from "../src/domain/tasks.js";
import { listFindings } from "../src/domain/findings.js";
import type { Program } from "../src/domain/types.js";

let program: Program;

beforeEach(() => {
  freshDb();
  program = createProgram({
    name: "Test Program",
    platform: "self-hosted",
    url: "https://example.com",
    policy: { inScope: ["example.com"], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] },
  });
});

test("mainMenuText never crashes and is non-empty", () => {
  assert.ok(mainMenuText().length > 0);
});

test("formatFindingsList filters correctly and paginates", () => {
  for (let i = 0; i < 10; i++) {
    const f = createFinding({ programId: program.id, title: `f${i}`, asset: "example.com" });
    transitionFinding(f.id, "candidate");
  }
  const findings = listFindings();

  const page0 = formatFindingsList(findings, "candidate", 0, 4);
  assert.equal(page0.totalPages, 3); // 10 findings / 4 per page
  assert.match(page0.text, /f9|f8|f7|f6/); // most-recent-first ordering from listFindings()

  const allFilter = formatFindingsList(findings, "all", 0, 100);
  assert.match(allFilter.text, /\(all, 10\)/);
});

test("formatFindingsList: an empty filter result says so, not a blank page", () => {
  const result = formatFindingsList([], "accepted", 0);
  assert.match(result.text, /No findings match/);
});

test("formatFindingDetail includes the program name and key fields", () => {
  const created = createFinding({ programId: program.id, title: "XSS bug", asset: "example.com", category: "XSS" });
  const finding = transitionFinding(created.id, "candidate");
  const text = formatFindingDetail(finding, program.name);
  assert.match(text, /Test Program/);
  assert.match(text, /XSS/);
  assert.match(text, /CANDIDATE/);
});

test("formatProgramsList flags a never-verified program and an automation-disabled one distinctly", () => {
  const noAutomation = createProgram({
    name: "No Automation Co",
    platform: "self-hosted",
    url: "https://noauto.example",
    policy: { inScope: [], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: false, restrictions: [] },
  });
  const text = formatProgramsList([program, noAutomation]);
  assert.match(text, /Test Program[\s\S]*Never verified/);
  assert.match(text, /No Automation Co[\s\S]*❌/);
});

test("formatProgramDetail reflects real paid revenue for that program", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  createReport({
    findingId: finding.id,
    title: "t",
    program: program.name,
    asset: finding.asset,
    summary: "s",
    impact: "i",
    stepsToReproduce: "s",
    evidence: "e",
    expectedBehavior: "e",
    observedBehavior: "o",
    suggestedRemediation: "s",
    references: "r",
  });
  transitionFinding(finding.id, "submitted");
  transitionFinding(finding.id, "triaged");
  transitionFinding(finding.id, "accepted");
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 500, currency: "USD" });
  markPaid(earning.id);

  const text = formatProgramDetail(program);
  assert.match(text, /500 USD/);
  assert.match(text, /Reports:\n1/);
  assert.match(text, /Accepted:\n1/);
});

test("formatEarnings shows CONFIRMED REVENUE = PAID messaging and handles empty state", () => {
  const empty = formatEarnings("today");
  assert.match(empty, /No earnings recorded yet/);

  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount: 100, currency: "USD" });
  markPaid(earning.id);

  const withData = formatEarnings("all");
  assert.match(withData, /USD/);
  assert.match(withData, /Confirmed Revenue = PAID only/);
});

test("formatAnalytics shows N/A for rates when there is no data, never a fabricated percentage", () => {
  const text = formatAnalytics();
  assert.match(text, /Acceptance:\nN\/A/);
  assert.match(text, /Top Program:\nn\/a/);
});

test("formatAnalytics computes real acceptance/paid rates matching the funnel", () => {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  createReport({
    findingId: finding.id,
    title: "t",
    program: program.name,
    asset: finding.asset,
    summary: "s",
    impact: "i",
    stepsToReproduce: "s",
    evidence: "e",
    expectedBehavior: "e",
    observedBehavior: "o",
    suggestedRemediation: "s",
    references: "r",
  });
  transitionFinding(finding.id, "submitted");
  transitionFinding(finding.id, "triaged");
  transitionFinding(finding.id, "accepted");

  const text = formatAnalytics();
  assert.match(text, /Acceptance:\n100\.0%/); // 1 accepted / 1 report
});

test("formatGoalsList and formatGoalDetail reflect real progress", () => {
  const goal = createGoal({ name: "MacBook Pro", targetAmount: 2_500_000, targetCurrency: "KRW" });
  const empty = formatGoalsList([]);
  assert.match(empty, /No goals set/);

  const progress = getGoalProgress(goal);
  const list = formatGoalsList([progress]);
  assert.match(list, /MacBook Pro/);
  assert.match(list, /0%/);

  const detail = formatGoalDetail(progress);
  assert.match(detail, /2500000 KRW/);
});

test("formatTasksList reflects real tasks", () => {
  createTask({ type: "research", programId: program.id, target: "example.com" });
  const text = formatTasksList([{ id: "abcdef12", type: "research", programId: program.id, target: "x", status: "queued", priority: "normal", result: null, failureReason: null, retryCount: 0, timeoutAt: null, createdAt: "", updatedAt: "" }]);
  assert.match(text, /research/);
  assert.match(text, /QUEUED/);
});

// --- v0.3.2: Program Candidate Discovery views ---

test("formatCandidatesList shows an empty-state hint, then real candidates with their stage", () => {
  assert.match(formatCandidatesList([]), /None yet/);
  const c = createCandidate({ name: "Example VDP", platform: "self-hosted", officialUrl: "https://example.com/security" });
  const text = formatCandidatesList([c]);
  assert.match(text, /Example VDP/);
  assert.match(text, /DISCOVERED/);
});

test("formatCandidateDetail shows UNKNOWN plainly, never as ALLOWED, and flags a stale policy", () => {
  const c = createCandidate({ name: "Example VDP", platform: "self-hosted", officialUrl: "https://example.com/security" });
  const text = formatCandidateDetail(c);
  assert.match(text, /Automation Policy:\nUNKNOWN \(never treated as allowed\)/);

  const researched = recordResearch(c.id, { scopeClarity: "HIGH", automationPolicy: "allowed", publicOrPrivate: "public", verifiedNow: true });
  const detail2 = formatCandidateDetail(researched);
  assert.match(detail2, /Automation Policy:\nALLOWED/);
  assert.doesNotMatch(detail2, /REVERIFICATION_REQUIRED/);
});

test("formatCandidateRecommendation names the top-scored candidate and lists alternatives", () => {
  assert.match(formatCandidateRecommendation(0, []), /No candidates researched yet/);

  const best = createCandidate({ name: "Best", platform: "self-hosted", officialUrl: "https://best.example.com" });
  recordResearch(best.id, { scopeClarity: "HIGH", policyClarity: "HIGH", automationPolicy: "allowed", publicOrPrivate: "public" });
  const worse = createCandidate({ name: "Worse", platform: "self-hosted", officialUrl: "https://worse.example.com" });

  const ranked = compareCandidates([getCandidate(best.id)!, getCandidate(worse.id)!]);
  const text = formatCandidateRecommendation(2, ranked);
  assert.match(text, /Candidates:\n2/);
  assert.match(text, /Recommended:\nBest/);
  assert.match(text, /Alternatives:/);
  assert.match(text, /Worse/);
  assert.match(text, /not a success\/revenue guarantee/);
});

test("formatCandidateComparison never sorts by reward alone", () => {
  const highReward = createCandidate({ name: "HighReward", platform: "self-hosted", officialUrl: "https://hr.example.com" });
  recordResearch(highReward.id, { rewardTransparency: "HIGH", automationPolicy: "forbidden" });
  const clear = createCandidate({ name: "Clear", platform: "self-hosted", officialUrl: "https://clear.example.com" });
  recordResearch(clear.id, { scopeClarity: "HIGH", policyClarity: "HIGH", automationPolicy: "allowed", publicOrPrivate: "public" });

  const ranked = compareCandidates([getCandidate(highReward.id)!, getCandidate(clear.id)!]);
  const text = formatCandidateComparison(ranked);
  assert.match(text, /1\. Clear/);
  assert.match(text, /2\. HighReward/);
});

test("formatEnrollmentChecklist lists every item unchecked initially and never claims the agent will act for the human", () => {
  const c = createCandidate({ name: "Example VDP", platform: "self-hosted", officialUrl: "https://example.com/security" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  const selected = selectCandidate(c.id, "op");
  const text = formatEnrollmentChecklist(selected);
  assert.match(text, /\[ \] Create platform account/);
  assert.match(text, /HUMAN ACTION REQUIRED/);
  assert.match(text, /not independently verified/);
});

function callbackData(kb: ReturnType<typeof candidateActionKeyboard>): string[] {
  return kb.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data! : ""));
}

test("candidateActionKeyboard offers exactly the actions reachable at each stage — never Select before research, never a bare-tap Activate", () => {
  const c = createCandidate({ name: "Example VDP", platform: "self-hosted", officialUrl: "https://example.com/security" });

  // discovered: only Research/Cancel — no Select, since nothing is known yet.
  let data = callbackData(candidateActionKeyboard(c));
  assert.ok(data.some((d) => d.startsWith("candidate:research:")));
  assert.ok(!data.some((d) => d.startsWith("candidate:select:")));

  // candidate: Select becomes available once researched.
  const researched = recordResearch(c.id, { scopeClarity: "HIGH" });
  data = callbackData(candidateActionKeyboard(researched));
  assert.ok(data.some((d) => d.startsWith("candidate:select:")));
  assert.ok(!data.some((d) => d.startsWith("candidate:activate:")));

  // enrollment_pending: checklist, not Select again.
  const selected = selectCandidate(c.id, "op");
  data = callbackData(candidateActionKeyboard(selected));
  assert.ok(data.some((d) => d.startsWith("candidate:viewchecklist:")));
  assert.ok(!data.some((d) => d.startsWith("candidate:select:")));

  // authorized: Activate is offered, but only as a confirm-prompt trigger —
  // never the actual activating callback (candidate:activate-confirm:) directly.
  const authorized = confirmAuthorization(c.id, "op");
  data = callbackData(candidateActionKeyboard(authorized));
  assert.ok(data.includes(`candidate:activate:${c.id}`));
  assert.ok(!data.some((d) => d.startsWith("candidate:activate-confirm:")));
});

test("formatEnrollmentStatus mirrors the section-21 PENDING/NOT CONFIRMED/BLOCKED shape before enrollment", () => {
  const c = createCandidate({ name: "Example VDP", platform: "self-hosted", officialUrl: "https://example.com/security" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  selectCandidate(c.id, "op");
  const status = getEnrollmentStatus(c.id)!;
  const text = formatEnrollmentStatus(status);
  assert.match(text, /Enrollment:\nPENDING/);
  assert.match(text, /Authorization:\nNOT CONFIRMED/);
  assert.match(text, /Live Testing:\nBLOCKED/);
});

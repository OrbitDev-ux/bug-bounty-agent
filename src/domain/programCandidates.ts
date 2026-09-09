import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { createProgram, getProgram } from "./programs.js";
import { isStale } from "./scope.js";
import { log } from "../logging/logger.js";
import type {
  AutomationPolicyStatus,
  ClarityLevel,
  EligibilityChecks,
  EnrollmentChecklistItem,
  Program,
  ProgramCandidate,
  ProgramCandidateSource,
  ProgramCandidateStage,
  ProgramPolicy,
  PublicOrPrivate,
} from "./types.js";

interface ProgramCandidateRow {
  id: string;
  name: string;
  platform: string;
  official_url: string;
  policy_url: string | null;
  canonical_url: string;
  stage: string;
  public_or_private: string;
  automation_policy: string;
  scope_summary: string | null;
  scope_clarity: string;
  policy_summary: string | null;
  policy_clarity: string;
  reward_summary: string | null;
  reward_transparency: string;
  eligibility_json: string;
  risks: string | null;
  sources_json: string;
  research_session_id: string | null;
  recommendation_score: number | null;
  recommendation_reason: string | null;
  enrollment_requirements: string | null;
  enrollment_checklist_json: string;
  selected_at: string | null;
  selected_by: string | null;
  authorization_confirmed_at: string | null;
  authorization_confirmed_by: string | null;
  cancelled_at: string | null;
  linked_program_id: string | null;
  policy_last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_ELIGIBILITY: EligibilityChecks = {
  publicProgram: "unknown",
  registrationRequired: "unknown",
  ageOrEligibilityRestrictions: "unknown",
  geographicRestrictions: "unknown",
  accountRequired: "unknown",
  termsAcceptanceRequired: "unknown",
  notes: "",
};

function rowToCandidate(row: ProgramCandidateRow): ProgramCandidate {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    officialUrl: row.official_url,
    policyUrl: row.policy_url,
    canonicalUrl: row.canonical_url,
    stage: row.stage as ProgramCandidateStage,
    publicOrPrivate: row.public_or_private as PublicOrPrivate,
    automationPolicy: row.automation_policy as AutomationPolicyStatus,
    scopeSummary: row.scope_summary,
    scopeClarity: row.scope_clarity as ClarityLevel,
    policySummary: row.policy_summary,
    policyClarity: row.policy_clarity as ClarityLevel,
    rewardSummary: row.reward_summary,
    rewardTransparency: row.reward_transparency as ClarityLevel,
    eligibility: JSON.parse(row.eligibility_json) as EligibilityChecks,
    risks: row.risks,
    sources: JSON.parse(row.sources_json) as ProgramCandidateSource[],
    researchSessionId: row.research_session_id,
    recommendationScore: row.recommendation_score,
    recommendationReason: row.recommendation_reason,
    enrollmentRequirements: row.enrollment_requirements,
    enrollmentChecklist: JSON.parse(row.enrollment_checklist_json) as EnrollmentChecklistItem[],
    selectedAt: row.selected_at,
    selectedBy: row.selected_by,
    authorizationConfirmedAt: row.authorization_confirmed_at,
    authorizationConfirmedBy: row.authorization_confirmed_by,
    cancelledAt: row.cancelled_at,
    linkedProgramId: row.linked_program_id,
    policyLastVerifiedAt: row.policy_last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Normalizes a URL for dedup (section 25): lowercase host, strip protocol,
 * "www.", trailing slash, query string, and fragment. Two URLs that differ
 * only by these never create two candidate rows for "the same" program.
 */
export function canonicalizeUrl(url: string): string {
  let v = url.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/^www\./, "");
  v = v.split("#")[0] ?? v;
  v = v.split("?")[0] ?? v;
  v = v.replace(/\/+$/, "");
  return v;
}

export function findCandidateByUrl(officialUrl: string): ProgramCandidate | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM program_candidates WHERE canonical_url = ?")
    .get(canonicalizeUrl(officialUrl)) as unknown as ProgramCandidateRow | undefined;
  return row ? rowToCandidate(row) : null;
}

export interface CreateCandidateInput {
  name: string;
  platform: string;
  officialUrl: string;
  policyUrl?: string | null;
}

/**
 * Idempotent by canonical URL (section 25 — "same platform/URL/name never
 * creates a duplicate row"): returns the existing candidate untouched if one
 * already exists for this URL, rather than inserting a second row.
 */
export function createCandidate(input: CreateCandidateInput): ProgramCandidate {
  const existing = findCandidateByUrl(input.officialUrl);
  if (existing) return existing;

  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO program_candidates (id, name, platform, official_url, policy_url, canonical_url, stage, eligibility_json, sources_json, enrollment_checklist_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, '[]', '[]', ?, ?)`,
  ).run(id, input.name, input.platform, input.officialUrl, input.policyUrl ?? null, canonicalizeUrl(input.officialUrl), JSON.stringify(DEFAULT_ELIGIBILITY), now, now);

  return mustGet(id);
}

export function getCandidate(id: string): ProgramCandidate | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM program_candidates WHERE id = ?").get(id) as unknown as ProgramCandidateRow | undefined;
  return row ? rowToCandidate(row) : null;
}

function mustGet(id: string): ProgramCandidate {
  const c = getCandidate(id);
  if (!c) throw new Error(`Program candidate not found: ${id}`);
  return c;
}

export interface ListCandidatesOptions {
  stage?: ProgramCandidateStage;
  includeCancelled?: boolean;
}

export function listCandidates(opts: ListCandidatesOptions = {}): ProgramCandidate[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: string[] = [];
  if (opts.stage) {
    clauses.push("stage = ?");
    params.push(opts.stage);
  }
  if (!opts.includeCancelled) {
    clauses.push("cancelled_at IS NULL");
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM program_candidates ${where} ORDER BY created_at DESC, rowid DESC`).all(...params) as unknown as ProgramCandidateRow[];
  return rows.map(rowToCandidate);
}

/**
 * Legal stage transitions (mirrors TASK_TRANSITIONS in tasks.ts). Enforced
 * centrally so no caller can skip a step — in particular, nothing can jump
 * straight to 'ready_for_research' without passing through 'authorized'.
 */
export const PROGRAM_CANDIDATE_TRANSITIONS: Record<ProgramCandidateStage, ProgramCandidateStage[]> = {
  discovered: ["researched"],
  researched: ["candidate"],
  candidate: ["enrollment_pending"],
  enrollment_pending: ["authorized"],
  authorized: ["ready_for_research"],
  ready_for_research: [],
};

export class InvalidProgramCandidateTransitionError extends Error {
  constructor(from: ProgramCandidateStage, to: ProgramCandidateStage) {
    super(`Invalid program candidate stage transition: ${from} -> ${to}`);
    this.name = "InvalidProgramCandidateTransitionError";
  }
}

function transitionStage(id: string, to: ProgramCandidateStage): ProgramCandidate {
  const candidate = mustGet(id);
  if (candidate.cancelledAt) throw new Error(`Program candidate ${id} was cancelled; cannot transition.`);
  const allowed = PROGRAM_CANDIDATE_TRANSITIONS[candidate.stage];
  if (!allowed.includes(to)) throw new InvalidProgramCandidateTransitionError(candidate.stage, to);

  const db = getDb();
  db.prepare("UPDATE program_candidates SET stage = ?, updated_at = ? WHERE id = ?").run(to, new Date().toISOString(), id);
  return mustGet(id);
}

export interface RecordResearchInput {
  scopeSummary?: string | null;
  scopeClarity?: ClarityLevel;
  policySummary?: string | null;
  policyClarity?: ClarityLevel;
  rewardSummary?: string | null;
  rewardTransparency?: ClarityLevel;
  automationPolicy?: AutomationPolicyStatus;
  publicOrPrivate?: PublicOrPrivate;
  eligibility?: EligibilityChecks;
  risks?: string | null;
  sources?: ProgramCandidateSource[];
  researchSessionId?: string | null;
  /** Set when the policy/scope was actually read just now — feeds isStale() for the freshness system (section 24). */
  verifiedNow?: boolean;
}

/**
 * Records research findings and advances discovered -> researched ->
 * candidate automatically (these two steps are desk research, not a human
 * decision — the human gate starts at [Select], section 30). Calling this
 * again later (re-verification) just updates the fields; it never regresses
 * the stage backward.
 */
export function recordResearch(id: string, input: RecordResearchInput): ProgramCandidate {
  const candidate = mustGet(id);
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE program_candidates SET
       scope_summary = COALESCE(?, scope_summary),
       scope_clarity = COALESCE(?, scope_clarity),
       policy_summary = COALESCE(?, policy_summary),
       policy_clarity = COALESCE(?, policy_clarity),
       reward_summary = COALESCE(?, reward_summary),
       reward_transparency = COALESCE(?, reward_transparency),
       automation_policy = COALESCE(?, automation_policy),
       public_or_private = COALESCE(?, public_or_private),
       eligibility_json = COALESCE(?, eligibility_json),
       risks = COALESCE(?, risks),
       sources_json = COALESCE(?, sources_json),
       research_session_id = COALESCE(?, research_session_id),
       policy_last_verified_at = CASE WHEN ? THEN ? ELSE policy_last_verified_at END,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    input.scopeSummary ?? null,
    input.scopeClarity ?? null,
    input.policySummary ?? null,
    input.policyClarity ?? null,
    input.rewardSummary ?? null,
    input.rewardTransparency ?? null,
    input.automationPolicy ?? null,
    input.publicOrPrivate ?? null,
    input.eligibility ? JSON.stringify(input.eligibility) : null,
    input.risks ?? null,
    input.sources ? JSON.stringify(input.sources) : null,
    input.researchSessionId ?? null,
    input.verifiedNow ? 1 : 0,
    now,
    now,
    id,
  );

  if (candidate.stage === "discovered") transitionStage(id, "researched");
  const afterResearched = mustGet(id);
  if (afterResearched.stage === "researched") return transitionStage(id, "candidate");
  return afterResearched;
}

const DEFAULT_ENROLLMENT_CHECKLIST: string[] = [
  "Create platform account",
  "Verify email",
  "Read program policy",
  "Accept program terms",
  "Confirm researcher eligibility",
  "Confirm automation restrictions",
  "Confirm disclosure policy",
  "Complete required profile information",
];

/**
 * Human Selection Gate (section 14): the only way a candidate moves past
 * 'candidate' is a human explicitly selecting it. Generates the enrollment
 * checklist (section 15) at the same moment — nothing here creates an
 * account or accepts terms on the human's behalf.
 */
export function selectCandidate(id: string, selectedBy: string): ProgramCandidate {
  const updated = transitionStage(id, "enrollment_pending");
  const db = getDb();
  const now = new Date().toISOString();
  const checklist: EnrollmentChecklistItem[] = DEFAULT_ENROLLMENT_CHECKLIST.map((item) => ({ item, done: false }));
  db.prepare(
    "UPDATE program_candidates SET selected_at = ?, selected_by = ?, enrollment_checklist_json = ?, updated_at = ? WHERE id = ?",
  ).run(now, selectedBy, JSON.stringify(checklist), now, id);
  void updated;
  log("candidate_selected", { candidateId: id, selectedBy });
  return mustGet(id);
}

export function toggleChecklistItem(id: string, index: number): ProgramCandidate {
  const candidate = mustGet(id);
  const checklist = [...candidate.enrollmentChecklist];
  if (index < 0 || index >= checklist.length) throw new Error(`Checklist index out of range: ${index}`);
  checklist[index] = { ...checklist[index]!, done: !checklist[index]!.done };
  const db = getDb();
  db.prepare("UPDATE program_candidates SET enrollment_checklist_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(checklist),
    new Date().toISOString(),
    id,
  );
  return mustGet(id);
}

/**
 * Authorization Confirmation (section 18): purely self-reported by the
 * human ("I have enrolled"). This function never verifies enrollment
 * against the actual platform — it records who said so and when, so that
 * fact is visible (not hidden) everywhere this candidate is displayed.
 */
export function confirmAuthorization(id: string, confirmedBy: string): ProgramCandidate {
  const updated = transitionStage(id, "authorized");
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE program_candidates SET authorization_confirmed_at = ?, authorization_confirmed_by = ?, updated_at = ? WHERE id = ?").run(
    now,
    confirmedBy,
    now,
    id,
  );
  void updated;
  log("candidate_authorized", { candidateId: id, confirmedBy, note: "self-reported, not independently verified" });
  return mustGet(id);
}

export interface ActivateForResearchInput {
  /** A freshly-extracted, structured ProgramPolicy — see agent/researcher.ts extractProgramPolicy(). Never derived from the candidate's free-text scopeSummary. */
  policy: ProgramPolicy;
}

export interface ActivateForResearchResult {
  candidate: ProgramCandidate;
  program: Program;
}

/**
 * Live Target Lock release point (sections 19-20): the ONLY function in this
 * module that creates a real, live-testable Program row. Requires the
 * candidate to already be 'authorized' (human confirmed enrollment) and
 * requires the caller to supply a policy that was extracted JUST NOW (not
 * reused from the candidate's earlier desk-research summary) — see
 * services/programResearch.ts activateCandidateForResearch(), which is the
 * only real caller and always re-verifies via extractProgramPolicy() first.
 */
export function activateForResearch(id: string, input: ActivateForResearchInput): ActivateForResearchResult {
  const updated = transitionStage(id, "ready_for_research");
  const program = createProgram({
    name: updated.name,
    platform: updated.platform,
    url: updated.policyUrl ?? updated.officialUrl,
    policy: input.policy,
    status: input.policy.automationAllowed ? "active" : "paused",
    policyVerifiedNow: true,
  });
  const db = getDb();
  db.prepare("UPDATE program_candidates SET linked_program_id = ?, updated_at = ? WHERE id = ?").run(program.id, new Date().toISOString(), id);
  return { candidate: mustGet(id), program };
}

export interface CancelResult {
  ok: boolean;
  reason: string;
}

/** Orthogonal to the stage machine (mirrors goals.ts archivedAt) — cancellable from any stage before a real Program exists. */
export function cancelCandidate(id: string, reason: string): CancelResult {
  const candidate = mustGet(id);
  if (candidate.stage === "ready_for_research" || candidate.linkedProgramId) {
    return { ok: false, reason: "Already activated into a live program — cancelling here would not affect it. Manage the live program directly instead." };
  }
  if (candidate.cancelledAt) return { ok: false, reason: "Already cancelled." };
  const db = getDb();
  db.prepare("UPDATE program_candidates SET cancelled_at = ?, updated_at = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), id);
  log("candidate_cancelled", { candidateId: id, reason });
  return { ok: true, reason: reason || "Cancelled." };
}

export interface SafetyState {
  blocked: boolean;
  reasons: string[];
}

/**
 * Safety State (section 31): defense-in-depth display/assertion helper.
 * Nothing in this codebase actually creates a Task from a candidate id, so
 * this is never bypassable in practice — but every caller that might one day
 * offer a "start research" action should check this first.
 */
export function getSafetyState(candidate: ProgramCandidate): SafetyState {
  const reasons: string[] = [];
  if (candidate.scopeClarity === "UNKNOWN") reasons.push("Scope unknown");
  if (candidate.policyClarity === "UNKNOWN") reasons.push("Policy unknown");
  if (candidate.automationPolicy === "unknown") reasons.push("Automation policy unknown");
  if (!candidate.authorizationConfirmedAt) reasons.push("Authorization unknown");
  if (candidate.stage !== "ready_for_research") reasons.push("Enrollment not complete");
  if (candidate.linkedProgramId) {
    const program = getProgram(candidate.linkedProgramId);
    if (!program || program.status !== "active") reasons.push("Program inactive");
  }
  return { blocked: reasons.length > 0, reasons };
}

/** True only once every Authorization Gate condition (section 20) is met. */
export function canStartLiveResearch(candidate: ProgramCandidate): boolean {
  return !getSafetyState(candidate).blocked && candidate.stage === "ready_for_research" && candidate.linkedProgramId !== null;
}

/** Policy Freshness (section 24) — reuses the same STALE_POLICY_DAYS system as live programs. */
export function needsReverification(candidate: ProgramCandidate): boolean {
  return isStale(candidate.policyLastVerifiedAt);
}

// --- Recommendation scoring (section 11) ---

function clarityPoints(level: ClarityLevel): number {
  return { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 }[level];
}

function automationPoints(status: AutomationPolicyStatus): number {
  return { allowed: 3, needs_review: 1.5, unknown: 0.5, forbidden: 0 }[status];
}

function publicPoints(v: PublicOrPrivate): number {
  return { public: 2, unknown: 1, private: 0 }[v];
}

function eligibilityPoints(e: EligibilityChecks): number {
  let score = 1; // neutral baseline
  if (e.publicProgram === "yes") score += 1;
  if (e.publicProgram === "no") score -= 1;
  if (e.ageOrEligibilityRestrictions === "yes") score -= 1;
  if (e.geographicRestrictions === "yes") score -= 1;
  return Math.max(0, Math.min(2, score));
}

export interface ScoredCandidate {
  candidate: ProgramCandidate;
  score: number; // 0-100, decision-support only
  reason: string;
}

/**
 * Recommendation Score (section 11): a deterministic, explainable heuristic
 * over Eligibility, Scope Clarity, Policy Clarity, Automation Compatibility,
 * Reward Transparency, and Research Accessibility (public/private). NEVER a
 * claim about real success odds or expected revenue — see the disclaimer
 * carried into every Telegram/CLI rendering of this score.
 */
export function computeRecommendationScore(candidate: ProgramCandidate): ScoredCandidate {
  const parts = {
    eligibility: eligibilityPoints(candidate.eligibility),
    scopeClarity: clarityPoints(candidate.scopeClarity),
    policyClarity: clarityPoints(candidate.policyClarity),
    automationCompatibility: automationPoints(candidate.automationPolicy),
    rewardTransparency: clarityPoints(candidate.rewardTransparency),
    researchAccessibility: publicPoints(candidate.publicOrPrivate),
  };
  const maxPossible = 2 + 3 + 3 + 3 + 3 + 2; // = 16
  const raw = Object.values(parts).reduce((a, b) => a + b, 0);
  const score = Math.round((raw / maxPossible) * 100);

  const reasonParts: string[] = [];
  if (parts.scopeClarity >= 2) reasonParts.push("clear published scope");
  if (parts.policyClarity >= 2) reasonParts.push("clear published policy");
  if (candidate.automationPolicy === "allowed") reasonParts.push("automated tooling explicitly permitted");
  else if (candidate.automationPolicy === "forbidden") reasonParts.push("automated tooling explicitly forbidden (manual research only)");
  else reasonParts.push("automation policy not confirmed");
  if (parts.rewardTransparency >= 2) reasonParts.push("transparent reward structure");
  if (candidate.publicOrPrivate === "public") reasonParts.push("open public program");

  return { candidate, score, reason: reasonParts.join("; ") || "Insufficient research to characterize this candidate yet." };
}

/** Comparison (section 10): sorted by score, highest first. Never sorts by reward alone. */
export function compareCandidates(candidates: ProgramCandidate[]): ScoredCandidate[] {
  return candidates.map(computeRecommendationScore).sort((a, b) => b.score - a.score);
}

export interface Recommendation {
  recommended: ScoredCandidate | null;
  alternatives: ScoredCandidate[];
}

/** Persists the computed score/reason onto the row so it survives a later plain getCandidate()/listCandidates() read. */
export function persistRecommendation(scored: ScoredCandidate): void {
  const db = getDb();
  db.prepare("UPDATE program_candidates SET recommendation_score = ?, recommendation_reason = ?, updated_at = ? WHERE id = ?").run(
    scored.score,
    scored.reason,
    new Date().toISOString(),
    scored.candidate.id,
  );
}

export function recommend(candidates: ProgramCandidate[]): Recommendation {
  const ranked = compareCandidates(candidates);
  for (const r of ranked) persistRecommendation(r);
  return { recommended: ranked[0] ?? null, alternatives: ranked.slice(1, 3) };
}

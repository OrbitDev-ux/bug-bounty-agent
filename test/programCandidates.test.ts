import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import {
  createCandidate,
  findCandidateByUrl,
  getCandidate,
  listCandidates,
  recordResearch,
  selectCandidate,
  toggleChecklistItem,
  confirmAuthorization,
  activateForResearch,
  cancelCandidate,
  canStartLiveResearch,
  getSafetyState,
  computeRecommendationScore,
  compareCandidates,
  recommend,
  InvalidProgramCandidateTransitionError,
  canonicalizeUrl,
} from "../src/domain/programCandidates.js";
import { getProgram } from "../src/domain/programs.js";
import type { EligibilityChecks } from "../src/domain/types.js";

const HIGH_TRUST_ELIGIBILITY: EligibilityChecks = {
  publicProgram: "yes",
  registrationRequired: "no",
  ageOrEligibilityRestrictions: "no",
  geographicRestrictions: "no",
  accountRequired: "no",
  termsAcceptanceRequired: "no",
  notes: "SIMULATED test fixture — no real program.",
};

const UNKNOWN_ELIGIBILITY: EligibilityChecks = {
  publicProgram: "unknown",
  registrationRequired: "unknown",
  ageOrEligibilityRestrictions: "unknown",
  geographicRestrictions: "unknown",
  accountRequired: "unknown",
  termsAcceptanceRequired: "unknown",
  notes: "",
};

beforeEach(() => {
  freshDb();
});

// --- Discovery + dedup (section 25) ---

test("createCandidate is idempotent by canonical URL — no duplicate rows for the same program", () => {
  const a = createCandidate({ name: "Example VDP", platform: "self-hosted", officialUrl: "https://Example.com/security/" });
  const b = createCandidate({ name: "Example VDP (again)", platform: "self-hosted", officialUrl: "http://www.example.com/security" });
  assert.equal(a.id, b.id);
  assert.equal(listCandidates().length, 1);
});

test("canonicalizeUrl normalizes protocol, www, trailing slash, query and fragment", () => {
  assert.equal(canonicalizeUrl("https://Example.com/security/"), canonicalizeUrl("http://www.example.com/security?ref=x#top"));
});

test("findCandidateByUrl finds an existing candidate by any equivalent URL form", () => {
  createCandidate({ name: "Example VDP", platform: "self-hosted", officialUrl: "https://example.com/security" });
  const found = findCandidateByUrl("https://www.example.com/security/");
  assert.ok(found);
  assert.equal(found!.name, "Example VDP");
});

// --- State machine (section 30, 32) ---

test("a fresh candidate starts 'discovered' and cannot skip stages", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  assert.equal(c.stage, "discovered");
  assert.throws(() => selectCandidate(c.id, "op"), InvalidProgramCandidateTransitionError);
});

test("recordResearch auto-advances discovered -> researched -> candidate (desk research, not a human gate)", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  const updated = recordResearch(c.id, {
    scopeSummary: "SIMULATED: p.example.com in scope",
    scopeClarity: "HIGH",
    automationPolicy: "allowed",
    publicOrPrivate: "public",
    eligibility: HIGH_TRUST_ELIGIBILITY,
    verifiedNow: true,
  });
  assert.equal(updated.stage, "candidate");
  assert.equal(updated.scopeClarity, "HIGH");
  assert.ok(updated.policyLastVerifiedAt);
});

test("recordResearch called again (re-verification) never regresses the stage backward", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  const again = recordResearch(c.id, { scopeClarity: "MEDIUM" });
  assert.equal(again.stage, "candidate");
  assert.equal(again.scopeClarity, "MEDIUM");
});

test("selectCandidate requires 'candidate' stage, generates a non-empty enrollment checklist, and records who selected it", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  const selected = selectCandidate(c.id, "telegram:12345");
  assert.equal(selected.stage, "enrollment_pending");
  assert.equal(selected.selectedBy, "telegram:12345");
  assert.ok(selected.enrollmentChecklist.length > 0);
  assert.ok(selected.enrollmentChecklist.every((i) => i.done === false));
});

test("toggleChecklistItem flips exactly one item", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  const selected = selectCandidate(c.id, "op");
  const toggled = toggleChecklistItem(c.id, 0);
  assert.equal(toggled.enrollmentChecklist[0]!.done, true);
  assert.equal(toggled.enrollmentChecklist[1]!.done, false);
  assert.equal(toggled.enrollmentChecklist.length, selected.enrollmentChecklist.length);
});

test("confirmAuthorization is purely self-reported — records who/when, never independently verified", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  selectCandidate(c.id, "op");
  const authorized = confirmAuthorization(c.id, "telegram:12345");
  assert.equal(authorized.stage, "authorized");
  assert.equal(authorized.authorizationConfirmedBy, "telegram:12345");
  assert.ok(authorized.authorizationConfirmedAt);
});

test("activateForResearch requires 'authorized' and creates a real, live Program row linked back to the candidate", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  recordResearch(c.id, { scopeClarity: "HIGH" });
  selectCandidate(c.id, "op");
  assert.throws(() => activateForResearch(c.id, { policy: { inScope: [], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] } }));

  confirmAuthorization(c.id, "op");
  const { candidate, program } = activateForResearch(c.id, {
    policy: { inScope: ["p.example.com"], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] },
  });
  assert.equal(candidate.stage, "ready_for_research");
  assert.equal(candidate.linkedProgramId, program.id);
  assert.equal(program.status, "active");
  assert.equal(getProgram(program.id)?.id, program.id);
});

test("cancelCandidate works before activation, refuses once a live program is linked", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  const cancelled = cancelCandidate(c.id, "SIMULATED: not interested");
  assert.equal(cancelled.ok, true);
  assert.equal(getCandidate(c.id)!.cancelledAt !== null, true);

  const c2 = createCandidate({ name: "Q", platform: "self-hosted", officialUrl: "https://q.example.com" });
  recordResearch(c2.id, { scopeClarity: "HIGH" });
  selectCandidate(c2.id, "op");
  confirmAuthorization(c2.id, "op");
  activateForResearch(c2.id, { policy: { inScope: ["q.example.com"], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] } });
  const refused = cancelCandidate(c2.id, "too late");
  assert.equal(refused.ok, false);
});

// --- Live Target Lock (sections 19-20, 31) ---

test("canStartLiveResearch is false for a freshly discovered candidate — everything unknown", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  assert.equal(canStartLiveResearch(c), false);
  const safety = getSafetyState(c);
  assert.equal(safety.blocked, true);
  assert.ok(safety.reasons.includes("Scope unknown"));
  assert.ok(safety.reasons.includes("Authorization unknown"));
});

test("canStartLiveResearch stays false all the way through 'authorized' — only true after activateForResearch", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  recordResearch(c.id, {
    scopeClarity: "HIGH",
    policyClarity: "HIGH",
    automationPolicy: "allowed",
    publicOrPrivate: "public",
    eligibility: HIGH_TRUST_ELIGIBILITY,
  });
  selectCandidate(c.id, "op");
  const authorized = confirmAuthorization(c.id, "op");
  assert.equal(canStartLiveResearch(authorized), false, "authorized but not yet activated — still blocked");

  const { candidate } = activateForResearch(c.id, {
    policy: { inScope: ["p.example.com"], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] },
  });
  assert.equal(canStartLiveResearch(candidate), true);
});

// --- Recommendation scoring (section 11) ---

test("computeRecommendationScore rates a clear, public, automation-friendly candidate above an unresearched one", () => {
  const clear = createCandidate({ name: "Clear", platform: "self-hosted", officialUrl: "https://clear.example.com" });
  recordResearch(clear.id, {
    scopeClarity: "HIGH",
    policyClarity: "HIGH",
    rewardTransparency: "HIGH",
    automationPolicy: "allowed",
    publicOrPrivate: "public",
    eligibility: HIGH_TRUST_ELIGIBILITY,
  });

  const vague = createCandidate({ name: "Vague", platform: "self-hosted", officialUrl: "https://vague.example.com" });

  const clearScore = computeRecommendationScore(getCandidate(clear.id)!);
  const vagueScore = computeRecommendationScore(getCandidate(vague.id)!);
  assert.ok(clearScore.score > vagueScore.score, `expected ${clearScore.score} > ${vagueScore.score}`);
  assert.equal(clearScore.score, 100);
});

test("computeRecommendationScore never treats forbidden automation as compatible", () => {
  const forbidden = createCandidate({ name: "Forbidden", platform: "self-hosted", officialUrl: "https://forbidden.example.com" });
  recordResearch(forbidden.id, { automationPolicy: "forbidden", scopeClarity: "HIGH", policyClarity: "HIGH", eligibility: UNKNOWN_ELIGIBILITY });
  const allowed = createCandidate({ name: "Allowed", platform: "self-hosted", officialUrl: "https://allowed.example.com" });
  recordResearch(allowed.id, { automationPolicy: "allowed", scopeClarity: "HIGH", policyClarity: "HIGH", eligibility: UNKNOWN_ELIGIBILITY });

  const forbiddenScore = computeRecommendationScore(getCandidate(forbidden.id)!);
  const allowedScore = computeRecommendationScore(getCandidate(allowed.id)!);
  assert.ok(allowedScore.score > forbiddenScore.score);
  assert.match(forbiddenScore.reason, /forbidden/i);
});

test("compareCandidates and recommend() sort by score, highest first, never by reward alone", () => {
  const highReward = createCandidate({ name: "HighReward", platform: "self-hosted", officialUrl: "https://hr.example.com" });
  recordResearch(highReward.id, { rewardSummary: "SIMULATED $50,000 max", rewardTransparency: "HIGH", scopeClarity: "UNKNOWN", policyClarity: "UNKNOWN", automationPolicy: "forbidden" });

  const clearScope = createCandidate({ name: "ClearScope", platform: "self-hosted", officialUrl: "https://cs.example.com" });
  recordResearch(clearScope.id, { scopeClarity: "HIGH", policyClarity: "HIGH", automationPolicy: "allowed", publicOrPrivate: "public", eligibility: HIGH_TRUST_ELIGIBILITY });

  const ranked = compareCandidates([getCandidate(highReward.id)!, getCandidate(clearScope.id)!]);
  assert.equal(ranked[0]!.candidate.id, clearScope.id, "clear/automation-friendly candidate should outrank a high-reward-but-opaque one");

  const rec = recommend([getCandidate(highReward.id)!, getCandidate(clearScope.id)!]);
  assert.equal(rec.recommended!.candidate.id, clearScope.id);
  assert.equal(rec.alternatives.length, 1);

  // persisted onto the row, per persistRecommendation()
  assert.equal(getCandidate(clearScope.id)!.recommendationScore, rec.recommended!.score);
});

test("listCandidates excludes cancelled by default, includes them with includeCancelled", () => {
  const c = createCandidate({ name: "P", platform: "self-hosted", officialUrl: "https://p.example.com" });
  cancelCandidate(c.id, "SIMULATED");
  assert.equal(listCandidates().length, 0);
  assert.equal(listCandidates({ includeCancelled: true }).length, 1);
});

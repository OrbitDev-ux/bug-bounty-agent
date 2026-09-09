import { discoverProgramCandidateLeads, researchProgramCandidate, extractProgramPolicy } from "../agent/researcher.js";
import { createCandidate, recordResearch, getCandidate, findCandidateByUrl, activateForResearch, type ActivateForResearchResult } from "../domain/programCandidates.js";
import { getDb } from "../db/client.js";
import { log } from "../logging/logger.js";
import type { ProgramCandidate } from "../domain/types.js";

export interface DiscoverAndCreateResult {
  ok: boolean;
  created: ProgramCandidate[];
  deduped: number;
  costUsd: number;
  error?: string;
}

/**
 * Program Discovery (section 3) end to end: searches for leads, then creates
 * (or, for an already-known URL, silently dedups against) a
 * program_candidates row for each one. Never researches them in depth here —
 * that's a separate, per-candidate call (researchCandidate below) so a
 * human can see the raw candidate list before spending more on deep-dives.
 */
export async function discoverAndCreateCandidates(topic: string): Promise<DiscoverAndCreateResult> {
  const result = await discoverProgramCandidateLeads(topic);
  if (!result.ok) {
    return { ok: false, created: [], deduped: 0, costUsd: result.costUsd, error: result.error };
  }

  const created: ProgramCandidate[] = [];
  let deduped = 0;
  for (const lead of result.leads) {
    const before = findCandidateByUrl(lead.officialUrl);
    const candidate = createCandidate({ name: lead.name, platform: lead.platform, officialUrl: lead.officialUrl });
    if (before) deduped++;
    else created.push(candidate);
  }
  log("candidate_discovery_completed", { topic, leadCount: result.leads.length, created: created.length, deduped, costUsd: result.costUsd });
  return { ok: true, created, deduped, costUsd: result.costUsd };
}

export interface ResearchCandidateResult {
  ok: boolean;
  candidate: ProgramCandidate | null;
  costUsd: number;
  error?: string;
}

/**
 * Deep-dive research on one already-discovered candidate (sections 6-9):
 * reads its official page, records everything found (or explicitly UNKNOWN),
 * and — on success — automatically advances discovered -> researched ->
 * candidate (desk research, not a human decision; the human gate is
 * [Select], not this step).
 */
export async function researchCandidate(candidateId: string): Promise<ResearchCandidateResult> {
  const candidate = getCandidate(candidateId);
  if (!candidate) return { ok: false, candidate: null, costUsd: 0, error: `Candidate not found: ${candidateId}` };

  const result = await researchProgramCandidate({ name: candidate.name, platform: candidate.platform, officialUrl: candidate.officialUrl });
  if (!result.ok || !result.output) {
    log("candidate_research_failed", { candidateId, error: result.error });
    return { ok: false, candidate, costUsd: result.costUsd, error: result.error };
  }

  const out = result.output;
  const updated = recordResearch(candidateId, {
    scopeSummary: out.scopeSummary || null,
    scopeClarity: out.scopeClarity,
    policySummary: out.policySummary || null,
    policyClarity: out.policyClarity,
    rewardSummary: out.rewardSummary || null,
    rewardTransparency: out.rewardTransparency,
    automationPolicy: out.automationPolicy,
    publicOrPrivate: out.publicOrPrivate,
    eligibility: out.eligibility,
    risks: out.risks || null,
    sources: out.sources,
    verifiedNow: true,
  });

  // policyUrl and enrollmentRequirements aren't part of recordResearch's
  // COALESCE-based patch (they're set-once/discovery-time fields), so update
  // them directly here when the deep-dive found something new.
  if (out.policyUrl || out.enrollmentRequirements) {
    const db = getDb();
    db.prepare("UPDATE program_candidates SET policy_url = COALESCE(?, policy_url), enrollment_requirements = COALESCE(?, enrollment_requirements) WHERE id = ?").run(
      out.policyUrl || null,
      out.enrollmentRequirements || null,
      candidateId,
    );
  }

  log("candidate_research_completed", { candidateId, stage: updated.stage, costUsd: result.costUsd });
  return { ok: true, candidate: getCandidate(candidateId), costUsd: result.costUsd };
}

export interface ActivateCandidateResult {
  ok: boolean;
  result: ActivateForResearchResult | null;
  costUsd: number;
  error?: string;
}

/**
 * Live Target Lock release (sections 19-20, 24): re-verifies the policy via
 * a FRESH extractProgramPolicy() call (never reuses the candidate's earlier
 * desk-research scopeSummary, which is free text, not a structured
 * ProgramPolicy, and may be stale) before creating the real, live-testable
 * Program row. Requires the candidate to already be 'authorized'.
 */
export async function activateCandidateForResearch(candidateId: string): Promise<ActivateCandidateResult> {
  const candidate = getCandidate(candidateId);
  if (!candidate) return { ok: false, result: null, costUsd: 0, error: `Candidate not found: ${candidateId}` };
  if (candidate.stage !== "authorized") {
    return { ok: false, result: null, costUsd: 0, error: `Candidate ${candidateId} is '${candidate.stage}', not 'authorized' — cannot activate.` };
  }

  const extraction = await extractProgramPolicy(candidate.policyUrl || candidate.officialUrl);
  if (!extraction.ok || !extraction.policy) {
    return { ok: false, result: null, costUsd: extraction.costUsd, error: extraction.error ?? "Policy re-verification failed." };
  }

  const result = activateForResearch(candidateId, { policy: extraction.policy });
  log("candidate_activated", { candidateId, programId: result.program.id, costUsd: extraction.costUsd });
  return { ok: true, result, costUsd: extraction.costUsd };
}

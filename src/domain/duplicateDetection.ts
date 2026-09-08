import type { DuplicateVerdict, Finding } from "./types.js";

/**
 * Deterministic duplicate detection (project brief section 14), compared
 * against a program's existing findings on asset/category/title/summary.
 * Deliberately NOT an LLM call: the "never auto-advance a likely duplicate"
 * safety rule should not depend on a model call succeeding, being well-
 * calibrated, or being reproducible run-to-run. This is the authoritative
 * verdict; a Research Agent's own opinion is advisory context only (see
 * researcher.ts), never a substitute for this check.
 */

export interface DuplicateCandidate {
  asset: string;
  category?: string | null;
  title: string;
  summary: string;
}

export interface DuplicateDetectionResult {
  verdict: DuplicateVerdict;
  matchedFindingId: string | null;
  score: number; // 0.0-1.0, similarity to the best match
  reason: string;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeAsset(asset: string): string {
  return asset.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

const LIKELY_DUPLICATE_THRESHOLD = 0.6;
const POSSIBLE_DUPLICATE_THRESHOLD = 0.3;

export function detectDuplicates(candidate: DuplicateCandidate, existing: Finding[]): DuplicateDetectionResult {
  const candidateTokens = tokenize(`${candidate.title} ${candidate.summary} ${candidate.category ?? ""}`);
  const candidateAsset = normalizeAsset(candidate.asset);

  let best: { finding: Finding; score: number } | null = null;

  for (const finding of existing) {
    const sameAsset = normalizeAsset(finding.asset) === candidateAsset;
    const sameCategory = Boolean(candidate.category) && finding.category === candidate.category;
    const textScore = jaccard(candidateTokens, tokenize(`${finding.title} ${finding.summary} ${finding.category ?? ""}`));

    // Same asset + same category is a strong prior on top of text overlap;
    // different assets can never score higher than pure text overlap alone.
    let score = textScore;
    if (sameAsset) score = Math.min(1, score + 0.3);
    if (sameAsset && sameCategory) score = Math.min(1, score + 0.2);
    if (!sameAsset) score = Math.min(score, textScore); // no asset-boost leakage

    if (!best || score > best.score) {
      best = { finding, score };
    }
  }

  if (!best || best.score < POSSIBLE_DUPLICATE_THRESHOLD) {
    return { verdict: "LIKELY_NEW", matchedFindingId: null, score: best?.score ?? 0, reason: "No existing finding is meaningfully similar." };
  }

  if (best.score >= LIKELY_DUPLICATE_THRESHOLD) {
    return {
      verdict: "LIKELY_DUPLICATE",
      matchedFindingId: best.finding.id,
      score: best.score,
      reason: `Strong overlap (asset/category/text, score=${best.score.toFixed(2)}) with existing finding "${best.finding.title}" (${best.finding.id}).`,
    };
  }

  return {
    verdict: "POSSIBLE_DUPLICATE",
    matchedFindingId: best.finding.id,
    score: best.score,
    reason: `Partial overlap (score=${best.score.toFixed(2)}) with existing finding "${best.finding.title}" (${best.finding.id}) — worth a human comparing them.`,
  };
}

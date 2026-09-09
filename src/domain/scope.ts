import type { Program, ProgramPolicy, ScopeVerdict } from "./types.js";

export interface ScopeDecision {
  allowed: boolean;
  reason: string;
}

export interface ScopeVerdictResult {
  verdict: ScopeVerdict;
  reason: string;
}

/**
 * A policy verified longer ago than this is treated as possibly stale
 * (project brief section 12 — "don't assume an old policy is still
 * current"). Only downgrades an otherwise-ALLOW verdict, and only when
 * `policyLastVerifiedAt` is actually set — records that never opted into
 * freshness tracking (e.g. plain v0.1 fixtures) are left alone.
 */
export const STALE_POLICY_DAYS = 90;

/** Exported for reuse by UI layers (Telegram/web) that want to show a staleness warning — see docs/dashboard.md and docs/telegram.md. */
export function isStale(policyLastVerifiedAt: string | null | undefined): boolean {
  if (!policyLastVerifiedAt) return false;
  const verifiedAt = new Date(policyLastVerifiedAt).getTime();
  if (Number.isNaN(verifiedAt)) return false;
  const ageMs = Date.now() - verifiedAt;
  return ageMs > STALE_POLICY_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Normalizes a target/pattern into a comparable hostname-ish string.
 * Strips protocol, path, query, and a leading "*." wildcard marker.
 */
function normalize(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "");
  v = v.split("/")[0] ?? v;
  v = v.split(":")[0] ?? v; // drop port
  return v;
}

/**
 * True if `target` matches `pattern`, where pattern may be a bare domain
 * ("example.com") or a wildcard subdomain pattern ("*.example.com").
 * Exact match or subdomain match only — never substring match, so
 * "notexample.com" never matches a pattern of "example.com".
 */
function matchesPattern(target: string, pattern: string): boolean {
  const t = normalize(target);
  let p = normalize(pattern);

  if (p.startsWith("*.")) {
    p = p.slice(2);
    return t === p || t.endsWith(`.${p}`);
  }
  return t === p || t.endsWith(`.${p}`);
}

/**
 * Central policy gate (v0.2): Target -> Scope -> Policy -> Automation Rules
 * -> Risk, per project brief section 10. Returns one of three verdicts —
 * uncertainty never resolves to ALLOW:
 *   - DENY: an explicit rule blocks this (paused program, out-of-scope
 *     match, automation forbidden, no matching in-scope entry).
 *   - NEEDS_HUMAN_REVIEW: the policy doesn't clearly say either way (no
 *     in-scope entries published at all, or the policy hasn't been
 *     verified recently enough to trust).
 *   - ALLOW: an explicit, fresh, in-scope match with automation permitted.
 */
export function evaluateScope(program: Program, target: string): ScopeVerdictResult {
  if (program.status !== "active") {
    return { verdict: "DENY", reason: `Program status is "${program.status}", not active.` };
  }

  const policy: ProgramPolicy = program.policy;

  if (!policy.automationAllowed) {
    return { verdict: "DENY", reason: "Program policy does not permit automated tooling." };
  }

  const outMatch = policy.outOfScope.find((p) => matchesPattern(target, p));
  if (outMatch) {
    return { verdict: "DENY", reason: `Target matches out-of-scope pattern "${outMatch}".` };
  }

  if (policy.inScope.length === 0) {
    return { verdict: "NEEDS_HUMAN_REVIEW", reason: "Program has no published in-scope entries — scope is unclear, not confirmed absent." };
  }

  const inMatch = policy.inScope.find((p) => matchesPattern(target, p));
  if (!inMatch) {
    return { verdict: "DENY", reason: "Target does not match any published in-scope pattern." };
  }

  if (isStale(program.policyLastVerifiedAt)) {
    return {
      verdict: "NEEDS_HUMAN_REVIEW",
      reason: `Target matches in-scope pattern "${inMatch}", but the policy was last verified on ${program.policyLastVerifiedAt} (over ${STALE_POLICY_DAYS} days ago) — re-verify before relying on it.`,
    };
  }

  return { verdict: "ALLOW", reason: `Target matches in-scope pattern "${inMatch}".` };
}

/**
 * v0.1-compatible boolean view of evaluateScope(), kept for existing callers
 * and tests. `allowed` is true only for an ALLOW verdict — both DENY and
 * NEEDS_HUMAN_REVIEW collapse to `false` here, since neither one means "go
 * ahead automatically." Callers that need to distinguish "blocked" from
 * "ask a human" should call evaluateScope() directly.
 */
export function checkScope(program: Program, target: string): ScopeDecision {
  const { verdict, reason } = evaluateScope(program, target);
  return { allowed: verdict === "ALLOW", reason };
}

/**
 * Convenience check for a specific action against forbidden-methods text.
 * This is a coarse keyword check over free-text policy, not a parser —
 * it exists to catch obvious violations (e.g. task type "scan" against a
 * policy that forbids "automated scanning"), not to be the only safeguard.
 */
export function checkMethodAllowed(program: Program, action: string): ScopeDecision {
  const a = action.toLowerCase();
  const forbidden = program.policy.forbiddenMethods.find((f) => a.includes(f.toLowerCase()) || f.toLowerCase().includes(a));
  if (forbidden) {
    return { allowed: false, reason: `Action "${action}" matches forbidden method "${forbidden}".` };
  }
  return { allowed: true, reason: "No matching forbidden method found." };
}

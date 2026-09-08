import type { Program, ProgramPolicy } from "./types.js";

export interface ScopeDecision {
  allowed: boolean;
  reason: string;
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
 * Central policy gate. Every module that is about to act on an external
 * target MUST call this first (Target -> Scope Check -> Policy Check -> Allowed?
 * per the project brief). Fails closed: any ambiguity resolves to `allowed: false`.
 */
export function checkScope(program: Program, target: string): ScopeDecision {
  if (program.status !== "active") {
    return { allowed: false, reason: `Program status is "${program.status}", not active.` };
  }

  const policy: ProgramPolicy = program.policy;

  if (!policy.automationAllowed) {
    return { allowed: false, reason: "Program policy does not permit automated tooling." };
  }

  const outMatch = policy.outOfScope.find((p) => matchesPattern(target, p));
  if (outMatch) {
    return { allowed: false, reason: `Target matches out-of-scope pattern "${outMatch}".` };
  }

  if (policy.inScope.length === 0) {
    return { allowed: false, reason: "Program has no published in-scope entries; failing closed." };
  }

  const inMatch = policy.inScope.find((p) => matchesPattern(target, p));
  if (!inMatch) {
    return { allowed: false, reason: "Target does not match any published in-scope pattern." };
  }

  return { allowed: true, reason: `Target matches in-scope pattern "${inMatch}".` };
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

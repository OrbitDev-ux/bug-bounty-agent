import { checkScope, evaluateScope, type ScopeDecision, type ScopeVerdictResult } from "../domain/scope.js";
import { getProgram } from "../domain/programs.js";
import { log } from "../logging/logger.js";

/**
 * Scope Checker role (project brief section 14): the mandatory
 * Target -> Scope Check -> Policy Check -> Allowed? gate every other role
 * must pass through before touching a target. Thin over domain/scope.ts —
 * its job here is to load the program and emit the audit log entries.
 */
export function checkTargetInScope(programId: string, target: string): ScopeDecision {
  const program = getProgram(programId);
  if (!program) {
    const decision: ScopeDecision = { allowed: false, reason: `Unknown program: ${programId}` };
    log("scope_rejected", { programId, target, reason: decision.reason });
    return decision;
  }

  const decision = checkScope(program, target);
  log(decision.allowed ? "scope_approved" : "scope_rejected", { programId, target, reason: decision.reason });
  return decision;
}

/** v0.2: three-state verdict (ALLOW/DENY/NEEDS_HUMAN_REVIEW), used everywhere the caller needs to distinguish "blocked" from "ask a human". */
export function evaluateTargetScope(programId: string, target: string): ScopeVerdictResult {
  const program = getProgram(programId);
  if (!program) {
    const result: ScopeVerdictResult = { verdict: "DENY", reason: `Unknown program: ${programId}` };
    log("scope_rejected", { programId, target, reason: result.reason });
    return result;
  }

  const result = evaluateScope(program, target);
  const event = result.verdict === "ALLOW" ? "scope_approved" : result.verdict === "DENY" ? "scope_rejected" : "scope_needs_review";
  log(event, { programId, target, reason: result.reason, verdict: result.verdict });
  return result;
}

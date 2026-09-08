import { checkScope, type ScopeDecision } from "../domain/scope.js";
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

import { recordCost } from "../domain/costs.js";

/**
 * Auto-records the REAL cost every `claude -p` call reports (section 39,
 * 42) — never an estimate, this is the exact `total_cost_usd` the CLI
 * itself returns. Called from src/agent/claudeRuntime.ts after every call
 * that reports a nonzero cost, success or failure (a failed call can still
 * have consumed real tokens).
 */
export function recordClaudeCost(costUsd: number, note: string): void {
  if (costUsd <= 0) return;
  recordCost({ category: "claude_api", amount: costUsd, currency: "USD", note, source: "auto:runClaude" });
}

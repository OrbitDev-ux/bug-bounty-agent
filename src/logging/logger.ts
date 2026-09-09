import { getDb } from "../db/client.js";

/**
 * Canonical event names for the audit trail (section 18 of the project brief).
 * Keep this list in sync with what the orchestrator/telegram/CLI actually emit.
 */
export type LogEvent =
  | "agent_started"
  | "agent_stopped"
  | "task_created"
  | "task_started"
  | "scope_approved"
  | "scope_rejected"
  | "scope_needs_review"
  | "approval_requested"
  | "approval_granted"
  | "approval_rejected"
  | "approval_expired"
  | "task_completed"
  | "task_failed"
  | "task_recovered"
  | "finding_created"
  | "finding_status_changed"
  | "research_session_started"
  | "research_session_completed"
  | "report_drafted"
  | "submission_completed"
  | "earning_updated"
  | "scheduler_started"
  | "scheduler_stopped"
  | "scheduler_paused"
  | "scheduler_resumed"
  | "agent_alert"
  | "startup_recovery"
  | "health_check"
  | "chat_intent_classified"
  | "chat_mode_changed";

const SECRET_KEY_PATTERN = /token|secret|key|password|authorization/i;

/**
 * Recursively strips values whose key looks secret-shaped, so a caller
 * accidentally passing a config object never leaks a token into agent_logs
 * or stdout. This is a safety net, not a substitute for not passing secrets in.
 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

export function log(event: LogEvent, detail?: Record<string, unknown>): void {
  const safeDetail = detail ? redact(detail) : undefined;
  const line = `[${new Date().toISOString()}] ${event}${safeDetail ? " " + JSON.stringify(safeDetail) : ""}`;
  console.error(line); // stderr keeps stdout clean for CLI/JSON consumers

  const db = getDb();
  db.prepare("INSERT INTO agent_logs (event, detail, created_at) VALUES (?, ?, ?)").run(
    event,
    safeDetail ? JSON.stringify(safeDetail) : null,
    new Date().toISOString(),
  );
}

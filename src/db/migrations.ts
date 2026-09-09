import type { DatabaseSync } from "node:sqlite";

/**
 * Lightweight, idempotent column migrations for tables that already existed
 * in v0.1 databases. `schema.sql`'s `CREATE TABLE IF NOT EXISTS` is a no-op
 * against an existing table, so new columns added in v0.2 need to be
 * ALTER'd in explicitly. No migration framework — just "does this column
 * exist yet, if not add it" checks, run every time getDb() opens a
 * connection. Safe to run against a brand-new database too (every column
 * will already exist from schema.sql, so every check is a no-op).
 */
export function runMigrations(db: DatabaseSync): void {
  addColumnIfMissing(db, "programs", "policy_last_verified_at", "TEXT");
  addColumnIfMissing(db, "programs", "policy_hash", "TEXT");

  addColumnIfMissing(db, "findings", "category", "TEXT");
  addColumnIfMissing(db, "findings", "confidence", "REAL");
  addColumnIfMissing(db, "findings", "confidence_reason", "TEXT");
  addColumnIfMissing(db, "findings", "duplicate_verdict", "TEXT");
  addColumnIfMissing(db, "findings", "duplicate_of_finding_id", "TEXT");
  addColumnIfMissing(db, "findings", "severity_candidate", "TEXT");
  addColumnIfMissing(db, "findings", "severity_reason", "TEXT");
  addColumnIfMissing(db, "findings", "severity_confidence", "REAL");
  addColumnIfMissing(db, "findings", "research_session_id", "TEXT");
  addColumnIfMissing(db, "findings", "submission_mode", "TEXT");

  addColumnIfMissing(db, "approvals", "expires_at", "TEXT");

  addColumnIfMissing(db, "tasks", "retry_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "tasks", "timeout_at", "TEXT");

  addColumnIfMissing(db, "earnings", "verification_source", "TEXT");
  addColumnIfMissing(db, "earnings", "verification_status", "TEXT NOT NULL DEFAULT 'UNVERIFIED'");
  addColumnIfMissing(db, "earnings", "exchange_rate", "REAL");
  addColumnIfMissing(db, "earnings", "rate_source", "TEXT");
  addColumnIfMissing(db, "earnings", "rate_timestamp", "TEXT");

  // v0.3.1
  addColumnIfMissing(db, "earnings", "external_submission_id", "TEXT");
  addColumnIfMissing(db, "earnings", "external_bounty_id", "TEXT");
  // Deferred here (not schema.sql) so the columns above are guaranteed to
  // exist first on an upgraded database — see the note in schema.sql.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_external_submission ON earnings(external_submission_id) WHERE external_submission_id IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_external_bounty ON earnings(external_bounty_id) WHERE external_bounty_id IS NOT NULL");

  addColumnIfMissing(db, "findings", "submitted_at", "TEXT");
  addColumnIfMissing(db, "findings", "accepted_at", "TEXT");

  addColumnIfMissing(db, "costs", "source", "TEXT NOT NULL DEFAULT 'manual'");

  addColumnIfMissing(db, "agent_settings", "notify_finding_alerts", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "agent_settings", "notify_approval_alerts", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "agent_settings", "notify_agent_errors", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "agent_settings", "notify_bounty_alerts", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "agent_settings", "notify_daily_summary", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "agent_settings", "notify_weekly_summary", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "agent_settings", "notify_goal_alerts", "INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing(db, "agent_settings", "quiet_until", "TEXT");
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

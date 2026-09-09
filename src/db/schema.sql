-- Bug Bounty Agent v0.1 schema. Kept flat and small on purpose: one file,
-- no ORM migrations framework, applied idempotently via CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS programs (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  platform                 TEXT NOT NULL,
  url                      TEXT NOT NULL,
  policy_json              TEXT NOT NULL, -- serialized ProgramPolicy
  status                   TEXT NOT NULL DEFAULT 'active',
  policy_last_verified_at  TEXT, -- v0.2: when the published policy was last actually read
  policy_hash              TEXT, -- v0.2: sha256 of policy_json, to detect drift on re-verification
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  program_id     TEXT REFERENCES programs(id), -- nullable: program-less discovery tasks have no program yet
  target         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
  priority       TEXT NOT NULL DEFAULT 'normal',
  result         TEXT,
  failure_reason TEXT,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  timeout_at     TEXT, -- v0.2: deadline set when entering 'running'; scheduler recovers stale runs past this
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_program ON tasks(program_id);

CREATE TABLE IF NOT EXISTS findings (
  id                       TEXT PRIMARY KEY,
  program_id               TEXT NOT NULL REFERENCES programs(id),
  task_id                  TEXT REFERENCES tasks(id),
  title                    TEXT NOT NULL,
  asset                    TEXT NOT NULL,
  summary                  TEXT NOT NULL DEFAULT '',
  status                   TEXT NOT NULL DEFAULT 'discovered',
  bounty_status            TEXT NOT NULL DEFAULT 'not_applicable',
  -- v0.2 candidate-finding intelligence (all nullable: only set for agent-generated candidates)
  category                 TEXT,
  confidence               REAL,   -- 0.0-1.0, agent's own confidence, never treated as ground truth
  confidence_reason        TEXT,
  duplicate_verdict        TEXT,   -- LIKELY_NEW | POSSIBLE_DUPLICATE | LIKELY_DUPLICATE
  duplicate_of_finding_id  TEXT REFERENCES findings(id),
  severity_candidate       TEXT,   -- suggested only, never auto-final
  severity_reason          TEXT,
  severity_confidence      REAL,
  research_session_id      TEXT REFERENCES research_sessions(id),
  submission_mode          TEXT,   -- SIMULATED | LIVE (v0.2 only ever writes SIMULATED)
  -- v0.3.1: time-to-bounty tracking (section 30) — stamped once, the first
  -- time the finding reaches that status; never recomputed from updated_at,
  -- which changes on every later edit.
  submitted_at              TEXT,
  accepted_at                TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_program ON findings(program_id);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);

CREATE TABLE IF NOT EXISTS approvals (
  id                          TEXT PRIMARY KEY,
  task_id                     TEXT REFERENCES tasks(id),
  finding_id                  TEXT REFERENCES findings(id),
  status                      TEXT NOT NULL DEFAULT 'pending',
  requested_action            TEXT NOT NULL,
  telegram_message_id         TEXT,
  decided_by_telegram_user_id TEXT,
  decided_at                  TEXT,
  expires_at                  TEXT, -- v0.2: replay/staleness protection; NULL = legacy row, never expires
  created_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- v0.2: a single continuous investigation of one program/topic — search
-- queries run, pages visited, evidence gathered, and the agent's own
-- summary/next-step recommendation. Resumable: status stays 'running'
-- until explicitly completed/failed, so a crashed process can pick back up.
CREATE TABLE IF NOT EXISTS research_sessions (
  id                       TEXT PRIMARY KEY,
  program_id               TEXT REFERENCES programs(id),
  task_id                  TEXT REFERENCES tasks(id),
  goal                     TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  queries_json             TEXT NOT NULL DEFAULT '[]',
  pages_visited_json       TEXT NOT NULL DEFAULT '[]',
  scope_observations       TEXT NOT NULL DEFAULT '',
  policy_observations       TEXT NOT NULL DEFAULT '',
  summary                  TEXT NOT NULL DEFAULT '',
  next_recommended_action  TEXT NOT NULL DEFAULT '',
  confidence                REAL,
  candidate_finding_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_sessions_status ON research_sessions(status);
CREATE INDEX IF NOT EXISTS idx_research_sessions_program ON research_sessions(program_id);

-- v0.2: every claim a research session or finding makes traces back to a
-- specific source. source_type distinguishes an official policy/scope page
-- from a third-party mention, per the official-source-priority rule.
CREATE TABLE IF NOT EXISTS source_evidence (
  id                  TEXT PRIMARY KEY,
  research_session_id TEXT REFERENCES research_sessions(id),
  finding_id          TEXT REFERENCES findings(id),
  source_url          TEXT NOT NULL,
  source_type         TEXT NOT NULL, -- OFFICIAL_POLICY | OFFICIAL_SCOPE | OFFICIAL_PROGRAM | PUBLIC_REFERENCE
  title               TEXT NOT NULL DEFAULT '',
  relevant_excerpt    TEXT NOT NULL DEFAULT '',
  captured_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_evidence_session ON source_evidence(research_session_id);
CREATE INDEX IF NOT EXISTS idx_source_evidence_finding ON source_evidence(finding_id);

-- v0.2: singleton row (id='singleton') tracking the persistent scheduler's
-- own state, independent of any one agent_runs row.
CREATE TABLE IF NOT EXISTS scheduler_state (
  id               TEXT PRIMARY KEY DEFAULT 'singleton',
  status           TEXT NOT NULL DEFAULT 'stopped', -- stopped | running | paused
  current_task_id  TEXT REFERENCES tasks(id),
  max_tasks_per_run INTEGER,
  max_runtime_ms   INTEGER,
  max_browser_ops  INTEGER,
  max_retries      INTEGER,
  tasks_run_this_run INTEGER NOT NULL DEFAULT 0,
  browser_ops_this_run INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id                    TEXT PRIMARY KEY,
  finding_id            TEXT NOT NULL REFERENCES findings(id),
  title                 TEXT NOT NULL,
  program               TEXT NOT NULL,
  asset                 TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  impact                TEXT NOT NULL DEFAULT '',
  steps_to_reproduce    TEXT NOT NULL DEFAULT '',
  evidence              TEXT NOT NULL DEFAULT '',
  expected_behavior     TEXT NOT NULL DEFAULT '',
  observed_behavior     TEXT NOT NULL DEFAULT '',
  suggested_remediation TEXT NOT NULL DEFAULT '',
  "references"          TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS earnings (
  id                TEXT PRIMARY KEY,
  finding_id        TEXT NOT NULL REFERENCES findings(id),
  program_id        TEXT NOT NULL REFERENCES programs(id),
  bounty_status     TEXT NOT NULL DEFAULT 'not_applicable',
  amount            REAL,
  currency          TEXT,
  awarded_at        TEXT,
  paid_at           TEXT,
  -- v0.3: bounty verification (section 24-25) — NULL verification_source means
  -- UNVERIFIED regardless of bounty_status; nothing here auto-promotes to "verified paid".
  verification_source TEXT,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED', -- UNVERIFIED | VERIFIED
  -- v0.3: currency handling (section 23) — original amount/currency above is
  -- always preserved; a conversion is only ever shown if these are all set.
  exchange_rate     REAL,
  rate_source       TEXT,
  rate_timestamp    TEXT,
  -- v0.3.1: idempotent dedup identity for a future real platform integration
  -- (section 45) — nullable; unique only when actually set (SQLite partial
  -- unique indexes below), so pre-v0.3.1 rows with NULL never collide.
  external_submission_id TEXT,
  external_bounty_id     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earnings_paid_at ON earnings(paid_at);
-- NOTE: the unique partial indexes on external_submission_id/external_bounty_id
-- are created in migrations.ts, not here — on an existing (pre-v0.3.1)
-- database those columns don't exist yet when this schema.sql block first
-- runs (CREATE TABLE IF NOT EXISTS is a no-op for an existing table), so
-- creating the index here would fail. migrations.ts adds the columns first,
-- then the indexes, in the correct order for both fresh and upgraded DBs.

-- v0.3: real, measured operating costs (never estimated) — see src/services/costs.ts,
-- which records the actual costUsd every runClaude() call reports.
CREATE TABLE IF NOT EXISTS costs (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL, -- claude_api | infrastructure | hosting | tools | other
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  note        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto:runClaude' | ...
  incurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_costs_incurred_at ON costs(incurred_at);
CREATE INDEX IF NOT EXISTS idx_costs_category ON costs(category);

-- v0.3: revenue goals (section 21). Progress is computed from PAID earnings
-- only, in the goal's own currency (no fabricated FX conversion — section 23).
CREATE TABLE IF NOT EXISTS goals (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  target_amount  REAL NOT NULL,
  target_currency TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  archived_at    TEXT
);

-- v0.3.1: tracks which (goal, threshold) pairs have already fired a Telegram
-- alert, so 25/50/75/100% each notify exactly once (section 33).
CREATE TABLE IF NOT EXISTS goal_alert_log (
  goal_id       TEXT NOT NULL REFERENCES goals(id),
  threshold_pct INTEGER NOT NULL,
  notified_at   TEXT NOT NULL,
  PRIMARY KEY (goal_id, threshold_pct)
);

-- v0.3: revenue change audit (section 39) — separate from earnings.updated_at
-- because that alone doesn't capture who changed it or the previous value.
CREATE TABLE IF NOT EXISTS revenue_audit (
  id            TEXT PRIMARY KEY,
  earning_id    TEXT NOT NULL REFERENCES earnings(id),
  who           TEXT NOT NULL, -- telegram user id, or 'cli-local-operator'
  what          TEXT NOT NULL, -- e.g. "marked awarded", "marked paid"
  source        TEXT NOT NULL, -- 'telegram' | 'web_dashboard' | 'cli'
  previous_value TEXT,         -- JSON snapshot
  new_value     TEXT,          -- JSON snapshot
  reason        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revenue_audit_earning ON revenue_audit(earning_id);

-- v0.3: Telegram AI chat mode + short conversation history (sections 32-35).
-- Not per-topic, one row per Telegram user — mode governs how plain-text
-- messages (non-slash-command) are routed.
CREATE TABLE IF NOT EXISTS chat_sessions (
  telegram_user_id TEXT PRIMARY KEY,
  mode             TEXT NOT NULL DEFAULT 'AGENT_CHAT', -- FREECHAT | AGENT_CHAT
  updated_at       TEXT NOT NULL
);

-- Bounded ring buffer per user (see src/telegram/chatMemory.ts for the prune
-- policy) — never stores secrets, never grows unbounded (section 35).
CREATE TABLE IF NOT EXISTS chat_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  role             TEXT NOT NULL, -- user | assistant
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(telegram_user_id, created_at);

-- v0.3: global operator settings (section 12). Singleton row, id='singleton'.
-- Deliberately has NO field to disable scope checks, approval gates, or
-- policy enforcement — those are not configurable, by design.
CREATE TABLE IF NOT EXISTS agent_settings (
  id                    TEXT PRIMARY KEY DEFAULT 'singleton',
  ai_model              TEXT NOT NULL DEFAULT 'sonnet',
  notification_level    TEXT NOT NULL DEFAULT 'important', -- all | important | none
  daily_summary_enabled INTEGER NOT NULL DEFAULT 1,
  agent_auto_start      INTEGER NOT NULL DEFAULT 0,
  research_enabled      INTEGER NOT NULL DEFAULT 1,
  -- v0.3.1: per-category notification toggles (section 47) — each defaults
  -- on. Critical security/failure alerts (safariUnavailableAlert,
  -- taskFailedRepeatedlyAlert) deliberately bypass all of these, per
  -- section 48 ("quiet mode never silences critical alerts").
  notify_finding_alerts    INTEGER NOT NULL DEFAULT 1,
  notify_approval_alerts   INTEGER NOT NULL DEFAULT 1,
  notify_agent_errors      INTEGER NOT NULL DEFAULT 1,
  notify_bounty_alerts     INTEGER NOT NULL DEFAULT 1,
  notify_daily_summary     INTEGER NOT NULL DEFAULT 1,
  notify_weekly_summary    INTEGER NOT NULL DEFAULT 1,
  notify_goal_alerts       INTEGER NOT NULL DEFAULT 1,
  -- v0.3.1: quiet mode (section 48) — non-critical alerts suppressed until this timestamp; NULL = not quiet.
  quiet_until               TEXT,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  task_id     TEXT REFERENCES tasks(id),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  summary     TEXT
);

-- Append-only audit trail. Never store secrets in `detail`.
CREATE TABLE IF NOT EXISTS agent_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_logs_event ON agent_logs(event);

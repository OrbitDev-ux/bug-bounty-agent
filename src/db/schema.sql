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
  id           TEXT PRIMARY KEY,
  finding_id   TEXT NOT NULL REFERENCES findings(id),
  program_id   TEXT NOT NULL REFERENCES programs(id),
  bounty_status TEXT NOT NULL DEFAULT 'not_applicable',
  amount       REAL,
  currency     TEXT,
  awarded_at   TEXT,
  paid_at      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earnings_paid_at ON earnings(paid_at);

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

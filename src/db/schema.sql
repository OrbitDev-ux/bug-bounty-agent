-- Bug Bounty Agent v0.1 schema. Kept flat and small on purpose: one file,
-- no ORM migrations framework, applied idempotently via CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS programs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  url          TEXT NOT NULL,
  policy_json  TEXT NOT NULL, -- serialized ProgramPolicy
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
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
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_program ON tasks(program_id);

CREATE TABLE IF NOT EXISTS findings (
  id            TEXT PRIMARY KEY,
  program_id    TEXT NOT NULL REFERENCES programs(id),
  task_id       TEXT REFERENCES tasks(id),
  title         TEXT NOT NULL,
  asset         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'discovered',
  bounty_status TEXT NOT NULL DEFAULT 'not_applicable',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
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
  created_at                  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

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

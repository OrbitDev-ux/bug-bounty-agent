# Bug Bounty Agent v0.2

A human-in-the-loop research automation agent for **authorized** bug bounty
programs. It reads public program policy pages (via a local Safari MCP
server), runs full Research Agent sessions with Claude, tracks programs,
tasks, candidate findings (with duplicate/confidence intelligence), reports,
and earnings in a local SQLite database, and routes anything scope-sensitive
through a Telegram approval gateway before it's considered actionable —
twice for anything reaching submission (candidate approval, then a
*separate* final approval), with all submission always recorded as
`SIMULATED` (no real platform API integration exists).

This is **research and approval-pipeline automation**, not exploit
automation. See [docs/security.md](docs/security.md) for exactly what this
agent will and will not do, including the section-40 security audit results.

## What's here

- **Domain layer** (`src/domain`) — Programs, Tasks, Findings (with
  candidate confidence/duplicate/severity intelligence), Approvals (with
  expiry/replay protection), Reports, Earnings, Research Sessions, Source
  Evidence, Scheduler State, and the Scope Manager (ALLOW/DENY/
  NEEDS_HUMAN_REVIEW), backed by SQLite (`node:sqlite`, no native deps,
  self-migrating in place).
- **Safari MCP** (`src/safari`) — a local MCP server exposing read-only
  Safari browsing tools, hardened against SSRF (blocks loopback/private/
  link-local hosts). See [docs/safari-mcp.md](docs/safari-mcp.md).
- **Telegram approval gateway** (`src/telegram`) — allowlisted human
  approval with a Finding Review card, `/status`, daily summaries, and
  replay-safe decisions. See [docs/telegram.md](docs/telegram.md).
- **Agent runtime** (`src/agent`) — wraps the local `claude` CLI as the
  Research Agent, Reporter, Scope Checker, Planner, and Scheduler roles.
  See [docs/agent.md](docs/agent.md), [docs/research-workflow.md](docs/research-workflow.md),
  [docs/scheduler.md](docs/scheduler.md).
- **Dashboard backend + metrics** (`src/services`) — data functions only
  (no web UI in v0.2), used by the CLI's `dashboard status` and Telegram's
  daily summary.
- **CLI** (`src/cli`) — `bba agent|program|task|finding|approval|earnings|safari|dashboard|telegram ...`

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_IDS to enable approvals
pnpm test               # 126 unit tests, no network/Telegram/Claude required
pnpm typecheck
pnpm run cli -- safari status         # confirms Safari automation works locally
pnpm run e2e:demo                     # search -> extract -> approve -> complete pipeline
pnpm run e2e:synthetic-finding        # candidate -> approval -> report -> SIMULATED submission
```

See [docs/setup.md](docs/setup.md) for the full setup walkthrough and what
each environment variable does.

## Architecture at a glance

See [docs/architecture.md](docs/architecture.md) for the full picture and
the reasoning behind each choice. Short version:

```
CLI / Telegram /status / e2e scripts
     │
     ▼
Scheduler ── Planner (selectNextTask: priority + FIFO)
     │
     ▼
Orchestrator ── Scope Manager (evaluateScope: ALLOW / DENY / NEEDS_HUMAN_REVIEW)
     │
     ├── Research Agent ──▶ claude -p --mcp-config mcp/safari.mcp.json (read-only Safari tools)
     │                       + deterministic Duplicate Detection (no LLM)
     ├── Reporter        ──▶ claude -p (no tools; drafts report fields from notes)
     │
     ▼
SQLite (programs, tasks, findings, approvals, reports, earnings,
        research_sessions, source_evidence, scheduler_state, agent_runs, agent_logs)
     │
     ▼
Telegram approval gateway (allowlisted users only, replay-protected)
```

## Status

See the final delivery report for verified-vs-not-yet-verified status per
component — this project does not mark anything "done" that hasn't actually
been run.

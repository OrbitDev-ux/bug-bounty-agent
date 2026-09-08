# Bug Bounty Agent v0.1

A human-in-the-loop research automation agent for **authorized** bug bounty
programs. It reads public program policy pages (via a local Safari MCP
server), extracts scope/policy with Claude, tracks programs/tasks/findings in
a local SQLite database, and routes anything scope-sensitive through a
Telegram approval gateway before it's considered actionable.

v0.1 is **research and approval-pipeline automation**, not exploit
automation. See [docs/security.md](docs/security.md) for exactly what this
agent will and will not do.

## What's here

- **Domain layer** (`src/domain`) — Programs, Tasks, Findings, Approvals,
  Reports, Earnings, Agent Runs, and the Scope Manager, backed by SQLite
  (`node:sqlite`, no native deps).
- **Safari MCP** (`src/safari`) — a local MCP server exposing read-only
  Safari browsing tools (open/search/read text/get links/find text,
  best-effort back/forward/scroll) over AppleScript. See
  [docs/safari-mcp.md](docs/safari-mcp.md).
- **Telegram approval gateway** (`src/telegram`) — allowlisted human approval
  over Telegram, with the decision logic separated from the network layer so
  it's unit-testable. See [docs/telegram.md](docs/telegram.md).
- **Agent runtime** (`src/agent`) — wraps the local `claude` CLI
  (`claude -p --output-format json`) as the Researcher and Reporter roles,
  with the Safari MCP server attached and tool access explicitly scoped. See
  [docs/agent.md](docs/agent.md).
- **CLI** (`src/cli`) — `bba agent|program|task|finding|approval|earnings|safari ...`

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_IDS to enable approvals
pnpm test               # 45 unit tests, no network/Telegram/Claude required
pnpm typecheck
pnpm run cli -- safari status      # confirms Safari automation works locally
pnpm run e2e:demo                  # full search -> extract -> approve -> complete pipeline
```

See [docs/setup.md](docs/setup.md) for the full setup walkthrough and what
each environment variable does.

## Architecture at a glance

See [docs/architecture.md](docs/architecture.md) for the full picture and
the reasoning behind each choice. Short version:

```
CLI / e2e-demo
     │
     ▼
Orchestrator ── Scope Manager (checkScope: Target -> Program Policy -> Allowed?)
     │
     ├── Researcher  ──▶ claude -p --mcp-config mcp/safari.mcp.json (read-only Safari tools)
     ├── Reporter     ──▶ claude -p (no tools; drafts report fields from notes)
     │
     ▼
SQLite (programs, tasks, findings, approvals, reports, earnings, agent_runs, agent_logs)
     │
     ▼
Telegram approval gateway (allowlisted users only)
```

## Status

See the final delivery report for verified-vs-not-yet-verified status per
component (Safari MCP, Telegram, Agent runtime, Scope Manager, etc.) — this
project does not mark anything "done" that hasn't actually been run.

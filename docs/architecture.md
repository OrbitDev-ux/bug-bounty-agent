# Architecture

## Why this shape

The project brief lays out a large long-term architecture (Scheduler, Task
Queue, Claude Agent, Scope Manager, Research/Reporting Engines, Approval
Gateway, Telegram Bot). v0.1 builds every one of those as a real module
boundary, but keeps each one as simple as the actual current scope allows —
no queue broker, no microservices, no daemon process manager. Everything
runs as a single local Node process (CLI, one-shot scripts, or the Telegram
bot's long-poll loop), talking to one SQLite file.

```
                         ┌─────────────────────┐
                         │         CLI          │  bba agent|program|task|finding|approval|earnings|safari|dashboard|telegram
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │     Orchestrator      │  src/agent/orchestrator.ts
                         │  (Planner/Scheduler,  │
                         │   thin glue only)     │
                         └──┬────────┬────────┬──┘
                            │        │        │
                 ┌──────────▼──┐ ┌───▼─────┐ ┌▼────────────┐
                 │Scope Checker│ │Researcher│ │  Reporter   │
                 │  (mandatory │ │(claude -p│ │ (claude -p, │
                 │   gate)     │ │ +Safari  │ │  no tools)  │
                 │             │ │  MCP)    │ │             │
                 └──────┬──────┘ └────┬─────┘ └──────┬──────┘
                        │             │              │
                        ▼             ▼              ▼
                 ┌─────────────────────────────────────────┐
                 │      SQLite (node:sqlite, one file)      │
                 │ programs / tasks / findings / approvals  │
                 │ reports / earnings / agent_runs / logs   │
                 └─────────────────┬─────────────────────────┘
                                   │
                         ┌─────────▼──────────┐
                         │   Telegram Bot      │  allowlisted approve/reject
                         │  (src/telegram)     │
                         └─────────────────────┘
```

## Module boundaries (project brief section 14)

| Role | File | Notes |
|---|---|---|
| Planner / Scheduler | `src/agent/orchestrator.ts` | Sequences the other roles; owns no policy logic itself. |
| Scope Checker | `src/agent/scopeChecker.ts` + `src/domain/scope.ts` | Every target hits this before anything else touches it. |
| Researcher | `src/agent/researcher.ts` | `claude -p` with the Safari MCP server attached, tools scoped to read-only. |
| Reporter | `src/agent/reporter.ts` | `claude -p` with **no** tools attached — drafts from notes only, can't reach the network. |
| Approval Manager | `src/telegram/*` | Allowlist + decision logic (`approvalHandler.ts`) is separated from the Telegram network layer (`bot.ts`) so it's unit-testable without a live bot. |
| Validator | *(not implemented in v0.1)* | See docs/security.md — validation execution is out of scope for v0.1 by design, not an oversight. |

These are separate files/exports, not separate processes — splitting them
into services is explicitly listed as a non-goal for v0.1 (section 33).

## Why SQLite via `node:sqlite`

Node 22+ ships a built-in synchronous SQLite driver. Using it means zero
native dependencies to compile (checked against this machine's Node 26/arm64
combination — `better-sqlite3`-style native modules are a real risk on a
brand-new Node version) and zero extra runtime services. One file,
`data/bug-bounty-agent.sqlite`, WAL mode, foreign keys on.

## Why the local `claude` CLI as the Agent runtime

Rather than adding a separate Claude API key and a bespoke agent loop, v0.1
shells out to the `claude` CLI already installed and authenticated in this
environment, in non-interactive mode:

```
claude -p "<prompt>" --output-format json --model sonnet \
  --max-budget-usd <cap> --no-session-persistence \
  --disallowedTools "Bash Edit Write NotebookEdit BashOutput KillShell" \
  [--mcp-config mcp/safari.mcp.json --strict-mcp-config --allowedTools "mcp__safari__..."] \
  [--json-schema '<schema>']
```

This was verified directly against this machine's `claude` CLI (v2.1.247):
plain calls return `{type:"result", result, total_cost_usd, ...}`; calls with
`--json-schema` additionally return a `structured_output` field the CLI has
already validated against the schema, which `researcher.ts`/`reporter.ts`
use instead of hand-parsing free text. See docs/agent.md for the exact
transcripts.

Every `claude -p` call in this project either has no MCP config (Reporter —
can't reach anything external) or has the Safari MCP config with
`--strict-mcp-config` and an explicit `--allowedTools` allowlist (Researcher
— can only call the specific read-only `safari_*` tools named). `Bash`,
`Edit`, `Write`, and friends are hard-disallowed on every call regardless.

## Why AppleScript (not WebDriver / a Safari extension) for Safari control

See docs/safari-mcp.md for the environment check that led to this choice and
its concrete limitations.

## Data model

`src/domain/types.ts` is the single source of truth for every entity shape;
`src/db/schema.sql` mirrors it 1:1 (one flat file, `CREATE TABLE IF NOT
EXISTS`, no migration framework — deliberately, for v0.1's size). State
machines for Task and Finding live in `src/domain/tasks.ts` /
`src/domain/findings.ts` as an explicit transition table
(`TASK_TRANSITIONS`, `FINDING_TRANSITIONS`), enforced on every write so no
caller can skip a state (e.g. jump straight to `completed` without going
through `waiting_approval`).

`Task.programId` is nullable: a program-less "research" task is how the
agent does public candidate-program discovery *before* any Program record
exists (section 4's "Safari 공개 웹 검색" step). Every other task type
requires a program, and `Finding.programId` is always required — you can't
have a finding before you have a program.

## v0.2 additions

v0.1's module boundaries turned out to be the right shape — v0.2 fills them
in rather than restructuring:

- **Scope Manager -> Scope Intelligence**: `evaluateScope()` now returns
  ALLOW/DENY/NEEDS_HUMAN_REVIEW instead of a boolean, with policy-freshness
  awareness. See docs/policy-engine.md.
- **Researcher -> full Research Agent**: `runResearchSession()` returns the
  complete structured shape (sources, observations, candidates, confidence,
  next action) and persists a resumable `ResearchSession` + `SourceEvidence`
  trail. See docs/research-workflow.md.
- **New: Duplicate Intelligence** (`src/domain/duplicateDetection.ts`,
  deterministic, not an LLM call) and **Candidate Finding fields** on
  `findings` (confidence/duplicate/severity, all advisory). See
  docs/policy-engine.md and docs/findings.md.
- **Approval Manager -> replay-safe**: expiry (`Approval.expiresAt`) added
  alongside v0.1's one-decision-only guarantee. See docs/security.md.
- **New: Planner + persistent Scheduler** (`src/agent/planner.ts`,
  `src/agent/scheduler.ts`): a real (bounded, run-limited) worker loop with
  crash recovery, replacing v0.1's bookkeeping-only `agent start`/`stop`.
  See docs/scheduler.md.
- **New: dashboard backend + metrics/ROI services** (`src/services/`) — data
  functions only, no HTTP server or web UI (out of scope per the brief).

## Known architectural gaps (see final report "Next Recommended Milestone")

- No OS-level daemonization — `agent start [--daemon]` is a bounded
  foreground worker-loop run, not a background service with its own process
  supervision. See docs/scheduler.md.
- `validate` and `submit` task types exist in the schema but have no
  automated executor — intentional (see docs/security.md); v0.2's
  `validated` state is reached via human approval, not automated testing.
- Report submission is always `SIMULATED`; there's no platform API
  integration (HackerOne/Bugcrowd) to actually submit anything.
- No web dashboard UI — only the backend data functions the brief asked for
  (section 37 explicitly scopes v0.2 to preparing that layer, not the UI).

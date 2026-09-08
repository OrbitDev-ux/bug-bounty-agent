# Security Model

## What this agent is

A research and approval-pipeline automation tool for programs you are
**already authorized** to test, per that program's own published policy.
Every capability in v0.1 stops at "read public information and propose a
next step for a human to approve."

## What this agent will not do (v0.1)

Per the project brief (sections 6, 20), the following are either not
implemented or actively blocked:

- **No arbitrary JavaScript execution** in Safari. `safari_page_text` /
  `safari_get_links` read the page's static HTML `source` via AppleScript —
  they do not `do JavaScript`, so there's no code-execution surface exposed
  through the MCP server. (This does mean JS-rendered single-page apps
  return little text — see docs/safari-mcp.md.)
- **No form submission, credential entry, or mass clicking.** The Safari MCP
  server has 12 tools; none of them fill forms, click page elements, or
  submit anything.
- **No destructive testing, DoS, or scanning.** v0.1 has no `validate` task
  execution at all — the `validate` task type exists in the schema for
  forward-compatibility but the orchestrator does not implement it.
  Automated tooling only ever happens through the Researcher role, which is
  restricted to Safari's read-only tool set.
- **Scope is fail-closed.** `checkScope()` (`src/domain/scope.ts`) requires
  an explicit in-scope match; a program with no published in-scope entries,
  a paused/closed program, or a program whose policy doesn't explicitly say
  automation is allowed, all resolve to `allowed: false`. Out-of-scope
  patterns are checked first and always win.
- **No non-http(s) URL schemes.** `safari_open_url` rejects `javascript:`,
  `data:`, `file:`, etc. via `assertHttpUrl()` in `src/safari/controller.ts`.
- **The `claude` CLI calls never get filesystem or shell tools.**
  `--disallowedTools "Bash Edit Write NotebookEdit BashOutput KillShell"` is
  on every single `runClaude()` invocation, and MCP tool access is always
  `--strict-mcp-config` plus an explicit `--allowedTools` list — never a
  blanket grant.

## Human-in-the-loop gates

| Action | Automated? | Gate |
|---|---|---|
| Public web search / reading a policy page | Yes | none — this is read-only public information |
| Extracting scope/policy into structured data | Yes | none, but see "Extraction is not ground truth" below |
| Creating a Program record from extracted policy | Yes | the extraction step itself is the check — nothing is added to scope without having read a policy page first |
| Confirming a target is in scope and continuing work on it | No | **Telegram approval required** (`waiting_approval` task state) |
| Drafting a report | Yes | drafts only from notes already given; no network access |
| Submitting a report / marking `submitted` | No | **final human approval required** (not automated in v0.1 at all — see below) |

## Extraction is not ground truth

`extractProgramPolicy()` (`src/agent/researcher.ts`) asks Claude to read a
policy page and produce structured scope data. This is genuinely useful (see
the verified GitHub Bug Bounty extraction in docs/agent.md) but it is a
best-effort reading of a web page, not an authoritative parse. Two
consequences enforced in code:

1. Program status is set to `paused` (not `active`) unless the extraction
   explicitly says `automationAllowed: true` — a paused program can still be
   recorded for tracking, but `checkScope()` blocks it outright.
2. A human still has to approve the resulting task before the agent
   considers a target "confirmed" — the extraction alone never green-lights
   anything.

**A human should still read the actual policy page before relying on this
for real testing.** Treat extraction as a fast first draft, not a legal
determination of scope.

## Telegram approval security

- **Allowlist is enforced on every decision**, not just at message-send
  time — `isAllowedTelegramUser()` is checked inside
  `handleApprovalDecision()`, so even a forged/replayed callback from a
  non-allowlisted chat is rejected and logged (`approval_granted`/
  `approval_rejected` with `outcome: "denied_not_allowlisted"`).
- **No secrets in logs.** `src/logging/logger.ts` redacts any object key
  matching `/token|secret|key|password|authorization/i` before writing to
  stdout or the `agent_logs` table. `TELEGRAM_BOT_TOKEN` is never logged,
  echoed, or included in any CLI output.
- **`.env` is git-ignored**; `.env.example` ships with empty values only.
- Approval records are decided **once** — `decideApproval()` throws if the
  approval is not `pending`, so a second callback tap (double-click, replay)
  cannot flip an already-decided approval.

## Threat model notes

- The agent trusts the local `claude` CLI's own auth/session — it does not
  handle or store API keys itself.
- The agent trusts whichever Safari tab is frontmost when a tool runs. It
  does not attempt to verify tab identity beyond reading the URL. If you run
  this against a machine with other Safari windows open, be aware
  `safari_current_tab`/`safari_page_text`/etc. always act on the
  **frontmost window's current tab**, which a script could confuse if you're
  also using the browser interactively at the same time.
- `back`/`forward`/`scroll` use macOS Accessibility (System Events GUI
  scripting) and will simply report `{ok:false}` with a clear message if
  Accessibility permission hasn't been granted to the terminal/`osascript` —
  they never silently do something else.

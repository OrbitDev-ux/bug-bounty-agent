# Agent Runtime

## What it is

`src/agent/claudeRuntime.ts` wraps the local `claude` CLI in non-interactive
mode. There is no separate SDK, no separate API key — it reuses whatever
authentication the `claude` CLI already has in this environment.

```ts
runClaude({
  prompt: "...",
  mcpConfigPath?: "mcp/safari.mcp.json",
  allowedTools?: ["mcp__safari__safari_open_url", ...],
  jsonSchema?: { ... },       // forces structured_output via `claude --json-schema`
  maxBudgetUsd?: 0.75,
  model?: "sonnet",
})
```

translates to:

```
claude -p "<prompt>" --output-format json --no-session-persistence \
  --model sonnet --max-budget-usd 0.75 \
  --disallowedTools "Bash Edit Write NotebookEdit BashOutput KillShell" \
  [--mcp-config mcp/safari.mcp.json --strict-mcp-config --allowedTools "..."] \
  [--json-schema '...']
```

## Verified transcripts (this environment, Claude Code CLI v2.1.247)

**1. Plain call, no tools:**
```
$ claude -p "Say the single word PONG and nothing else." --output-format json --model sonnet --max-budget-usd 0.05
{"...","is_error":false,"result":"PONG","total_cost_usd":0.040428,...}
```

**2. Structured output via `--json-schema`:**
```
$ claude -p "Reply with a JSON object describing yourself." --json-schema '{...}' ...
{"...","result":"{\"name\":...}","structured_output":{"name":"Claude (Sonnet 5)","good_at":[...]},"is_error":false,...}
```
`structured_output` is what `runClaude()` returns as `.structuredOutput` —
`researcher.ts` and `reporter.ts` both rely on this rather than parsing free
text.

**3. Full Researcher path — Claude driving the real Safari MCP server:**
```
$ claude -p "Use the safari_open_url tool to open https://en.wikipedia.org/wiki/Bug_bounty_program, \
  then use safari_page_text to read some of the page, then reply with just the page title \
  you found and one sentence describing what the page is about." \
  --mcp-config mcp/safari.mcp.json --strict-mcp-config \
  --allowedTools "mcp__safari__safari_open_url mcp__safari__safari_page_text mcp__safari__safari_current_tab" \
  --permission-mode acceptEdits ...
{"num_turns":4,"permission_denials":[],"is_error":false,
 "result":"**Bug bounty program - Wikipedia** — The page describes bug bounty programs, deals offered by organizations that reward individuals (bug bounty hunters/ethical hackers) for finding and reporting software vulnerabilities."}
```
`num_turns: 4` and `permission_denials: []` confirm Claude actually called
the Safari MCP tools (open, read) rather than answering from its own
knowledge — and the answer is specific to what Safari actually rendered.

**4. `extractProgramPolicy()` against a real, live program — GitHub's public
Bug Bounty policy (`https://bounty.github.com/`):**

Returned a structured, schema-valid policy with correctly identified
in-scope domains (`github.com`, `githubassets.com`, `githubusercontent.com`,
`npmjs.com`, ...), out-of-scope subdomains (`blog.github.com`,
`shop.github.com`, ...), allowed/forbidden testing methods, restrictions
(safe-harbor conditions, PII handling, disclosure timing), and
`automationAllowed: true` — correctly read from the page's explicit
statement that reasonable automated scanning is permitted. Cost: ~$0.10–0.22
per extraction depending on how many linked pages it reads.

**5. Full pipeline via the CLI** (`pnpm run cli -- program add --name "GitHub Bug Bounty" --platform HackerOne --policy-url https://bounty.github.com/`):

```
finding_created  program_created  programId=... status=active
task_created     type=scope_check target=github.com
task_started
scope_approved   reason="Target matches in-scope pattern \"github.com\"."
approval_requested
Program created: ... (status=active)
Task: ... (status=waiting_approval)
Scope check: Target matches in-scope pattern "github.com". (Telegram delivery skipped: TELEGRAM_BOT_TOKEN not set)
Telegram approval requested: false
Claude cost: $0.1352
```

Then, decided directly (no live Telegram token in this environment — see
docs/telegram.md):
```
$ TELEGRAM_ALLOWED_USER_IDS=999999 handleApprovalDecision(approvalId, "approved", "999999")
-> task waiting_approval -> approved
$ bba task run <id>
-> task approved -> completed
```

The full `pnpm run e2e:demo` script runs all of this in one shot,
end-to-end, against a fresh database — see its output captured during
development for the complete 11-step transcript matching project brief
section 27.

## Cost discipline

Every `runClaude()` call carries a `maxBudgetUsd` (`researcher.ts`: $0.75,
`reporter.ts`: $0.50) passed straight to `claude --max-budget-usd`, which the
CLI itself enforces server-side (confirmed: a call given `--max-budget-usd
0.05` against a task needing more budget terminated early with
`subtype: "error_max_budget_usd"` rather than continuing to spend). Nothing
in this project makes an unbounded-cost Claude call.

## What's NOT implemented

- **Validator role** — no code path executes actual vulnerability testing.
  `TaskType` includes `"validate"` in the schema for forward-compatibility,
  but the orchestrator has no handler for it. This is intentional (see
  docs/security.md), not a missing feature to bolt on carelessly later.
- **Automatic report submission** to a real platform (HackerOne/Bugcrowd
  API) — `reporter.ts` only drafts report text; nothing calls out to submit
  it anywhere.

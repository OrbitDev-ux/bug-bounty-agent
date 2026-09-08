# Setup

Verified on: macOS 26.5.2 (Darwin 25.5.0, arm64/T8140), Node v26.4.0, pnpm
11.15.1, git 2.50.1, Claude Code CLI 2.1.247, sqlite3 3.51.0.

## 1. Install

```bash
pnpm install
```

No native modules to compile — storage uses Node's built-in `node:sqlite`
(Node 22.5+).

## 2. Environment

```bash
cp .env.example .env
```

| Variable | Required for | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram approvals | From @BotFather. Never commit this. |
| `TELEGRAM_ALLOWED_USER_IDS` | Telegram approvals | Comma-separated numeric Telegram user IDs, from @userinfobot. Approvals from anyone else are rejected. |
| `DATABASE_PATH` | everything | Defaults to `./data/bug-bounty-agent.sqlite`. |
| `CLAUDE_MODEL` | Researcher/Reporter | Defaults to `sonnet`. |
| `CLAUDE_MAX_BUDGET_USD` | Researcher/Reporter | Per-call USD cap passed to `claude -p --max-budget-usd`. Defaults to `1.00`. |
| `SAFARI_MCP_CONFIG` | Researcher | Path to the MCP config file. Defaults to `./mcp/safari.mcp.json`. |

Without a `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALLOWED_USER_IDS`, everything up to
and including scope-checking and creating a pending Approval record still
works — only the actual Telegram message delivery is skipped (and clearly
reported as such). See docs/telegram.md.

## 3. Claude Code CLI

The agent runtime shells out to the `claude` CLI already installed on this
machine, using whatever authentication it already has (this project never
asks for or stores a separate API key). Confirm it works:

```bash
claude -p "Say PONG" --output-format json --max-budget-usd 0.05
```

If that fails, fix your `claude` CLI auth first — nothing in this project
can work around that.

## 4. Safari automation permission

The Safari MCP server drives Safari via AppleScript (`osascript`). The first
time you run it, macOS will prompt for **Automation** permission for
whichever process runs `osascript` (Terminal, or your terminal app) to
control Safari — approve it once via
**System Settings → Privacy & Security → Automation**.

`back`/`forward`/`scroll` additionally need **Accessibility** permission for
the same process (System Events GUI scripting) — optional; every other tool
works without it. See docs/safari-mcp.md.

Verify:

```bash
pnpm run cli -- safari status
```

## 5. Verify everything

```bash
pnpm typecheck
pnpm lint
pnpm test          # 126 tests, no network required
pnpm run build
```

## 6. Try the pipeline

```bash
# Public research, no program/approval needed:
pnpm run cli -- task research "recently launched bug bounty programs fintech"

# Agent-assisted program onboarding (reads a real policy page, extracts scope,
# creates a Program + Task, requests Telegram approval if configured):
pnpm run cli -- program add --name "Example Co" --platform HackerOne \
  --policy-url "https://bounty.github.com/"

# Full scripted end-to-end demo (see docs/agent.md for a verified transcript):
pnpm run e2e:demo

# v0.2: full Research Agent session against a real program (creates candidate
# findings, requests Telegram approval for each novel one):
pnpm run cli -- program research <programId> "research goal"

# v0.2: synthetic-finding pipeline demo — candidate -> approval -> report
# draft -> final approval -> SIMULATED submission -> bounty lifecycle,
# using a fabricated finding (never a real vulnerability):
pnpm run e2e:synthetic-finding

# v0.2: bounded worker loop (Scheduler -> Planner -> Task -> Result), never
# unbounded — see docs/scheduler.md for the default run limits:
pnpm run cli -- agent start
pnpm run cli -- agent run-once   # exactly one task, then exits
pnpm run cli -- agent status     # scheduler state + queue + approvals + Safari availability
pnpm run cli -- dashboard status # program/finding/earnings stats, metrics, ROI
```

## 7. Run the Telegram bot (optional, needs step 2's Telegram vars)

```bash
pnpm run telegram-bot
```

Long-polls for callback taps on approval cards (including the v0.2 Finding
Review card) and responds to `/start`/`/status`. Ctrl+C to stop.

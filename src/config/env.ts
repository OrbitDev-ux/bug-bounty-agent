import { existsSync } from "node:fs";

// Node >= 20.6 supports process.loadEnvFile natively — no dotenv dependency needed.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

/**
 * Hard safety switch: Node's test runner sets NODE_TEST_CONTEXT on every
 * test process (and it propagates to any child process a test spawns via
 * `env: {...process.env}`, e.g. the CLI subprocess tests). A real
 * TELEGRAM_BOT_TOKEN from a developer's .env must NEVER reach a test
 * process — a test exercising the approval/notification code path would
 * otherwise send a live message to the operator's real Telegram chat.
 *
 * Only the token is stripped here, deliberately NOT
 * TELEGRAM_ALLOWED_USER_IDS — that's a list of numeric ids, not a secret,
 * and several tests legitimately set it themselves to exercise allowlist
 * logic without needing a real token. telegramConfigStatus() requires BOTH
 * to be present to report "ready", so clearing the token alone is already
 * sufficient to make every send path a no-op during tests.
 */
if (process.env.NODE_TEST_CONTEXT) {
  delete process.env.TELEGRAM_BOT_TOKEN;
}

function parseAllowedIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const env = {
  databasePath: process.env.DATABASE_PATH ?? "./data/bug-bounty-agent.sqlite",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramAllowedUserIds: parseAllowedIds(process.env.TELEGRAM_ALLOWED_USER_IDS),
  claudeModel: process.env.CLAUDE_MODEL ?? "sonnet",
  claudeMaxBudgetUsd: Number(process.env.CLAUDE_MAX_BUDGET_USD ?? "1.00"),
  safariMcpEntrypoint: process.env.SAFARI_MCP_ENTRYPOINT ?? "./src/safari/mcp-server.ts",
  safariMcpEntrypointMcpConfig: process.env.SAFARI_MCP_CONFIG ?? "./mcp/safari.mcp.json",
} as const;

/** Never logs the token itself — only whether config looks usable. */
export function telegramConfigStatus(): "ready" | "missing_token" | "missing_allowlist" {
  if (!env.telegramBotToken) return "missing_token";
  if (env.telegramAllowedUserIds.length === 0) return "missing_allowlist";
  return "ready";
}

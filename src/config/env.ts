import { existsSync } from "node:fs";

// Node >= 20.6 supports process.loadEnvFile natively — no dotenv dependency needed.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
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

/**
 * Security boundary for the entire approval gateway (project brief section 12):
 * only Telegram user IDs explicitly listed in TELEGRAM_ALLOWED_USER_IDS may
 * approve or reject anything. Every caller MUST check this before acting on
 * a callback — never trust a Telegram user ID without this check.
 *
 * Reads process.env directly (not the cached config/env.ts snapshot) so tests
 * can flip the allowlist per-case without re-importing modules.
 */
export function isAllowedTelegramUser(telegramUserId: string | number, allowedIdsRaw = process.env.TELEGRAM_ALLOWED_USER_IDS): boolean {
  const id = String(telegramUserId);
  const allowed = (allowedIdsRaw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(id);
}

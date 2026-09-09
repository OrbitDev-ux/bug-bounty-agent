import { getSettings } from "../domain/settings.js";
import { telegramConfigStatus, env } from "../config/env.js";
import { log } from "../logging/logger.js";

/**
 * Telegram health/error alerts (project brief section 31). Best-effort and
 * silent-if-unconfigured, same guarantee as every other Telegram send in
 * this project — an alert failing to deliver must never crash the caller
 * (often the worker loop itself, mid-recovery).
 */

export type AlertLevel = "important" | "all";

function shouldSend(level: AlertLevel): boolean {
  const settings = getSettings();
  if (settings.notificationLevel === "none") return false;
  if (settings.notificationLevel === "important") return level === "important";
  return true; // "all"
}

export async function sendAlert(title: string, body: string, level: AlertLevel = "important"): Promise<boolean> {
  log("agent_alert", { title });
  if (!shouldSend(level)) return false;
  if (telegramConfigStatus() !== "ready") return false;

  try {
    // Lazy import to avoid a require-cycle with telegram/bot.ts, which itself
    // may want to use alerts.ts in the future.
    const { getBot } = await import("../telegram/bot.js");
    const bot = getBot();
    const text = `${title}\n\n${body}`;
    for (const chatId of env.telegramAllowedUserIds) {
      await bot.api.sendMessage(chatId, text);
    }
    return true;
  } catch (err) {
    log("agent_alert", { title, deliveryError: (err as Error).message });
    return false;
  }
}

export function safariUnavailableAlert(reason: string): Promise<boolean> {
  return sendAlert("⚠️ AGENT ALERT\n\nSafari unavailable", `Agent automatically paused.\n\nReason:\n${reason}`, "important");
}

export function taskFailedRepeatedlyAlert(taskId: string, failureCount: number): Promise<boolean> {
  return sendAlert(
    "🚨 AGENT ERROR",
    `Task #${taskId.slice(0, 8)} failed ${failureCount} times in a row.\n\nAgent paused for safety.`,
    "important",
  );
}

export function goalMilestoneAlert(goalName: string, percent: number): Promise<boolean> {
  return sendAlert("🎯 GOAL PROGRESS", `"${goalName}" reached ${percent}% of target.`, "all");
}

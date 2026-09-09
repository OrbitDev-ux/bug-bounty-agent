import { getSettings, isQuiet } from "../domain/settings.js";
import { telegramConfigStatus, env } from "../config/env.js";
import { log } from "../logging/logger.js";
import type { NotificationPreferences } from "../domain/types.js";

/**
 * Telegram health/error/revenue alerts (project brief sections 31, 34-36,
 * 47-48). Best-effort and silent-if-unconfigured, same guarantee as every
 * other Telegram send in this project — an alert failing to deliver must
 * never crash the caller (often the worker loop itself, mid-recovery).
 *
 * Three levels:
 *   - "critical": ALWAYS sent — bypasses notificationLevel, quiet mode, and
 *     every per-category toggle. Reserved for safety alerts (Safari down,
 *     repeated task failure) per section 48: "quiet mode never silences
 *     critical alerts."
 *   - "important" / "all": respects the global notificationLevel setting,
 *     quiet mode, and (when a category is given) that category's toggle.
 */
export type AlertLevel = "critical" | "important" | "all";

export function shouldSend(level: AlertLevel, category?: keyof NotificationPreferences): boolean {
  if (level === "critical") return true;

  const settings = getSettings();
  if (settings.notificationLevel === "none") return false;
  if (isQuiet()) return false;
  if (category && !settings.notifications[category]) return false;
  if (level === "important") return true; // notificationLevel is 'important' or 'all', both include important-level alerts
  return settings.notificationLevel === "all";
}

export async function sendAlert(title: string, body: string, level: AlertLevel = "important", category?: keyof NotificationPreferences): Promise<boolean> {
  log("agent_alert", { title });
  if (!shouldSend(level, category)) return false;
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

// --- Critical (section 31, 48 — always delivered) ---

export function safariUnavailableAlert(reason: string): Promise<boolean> {
  return sendAlert("⚠️ AGENT ALERT\n\nSafari unavailable", `Agent automatically paused.\n\nReason:\n${reason}\n\nUse /status for details.`, "critical");
}

export function taskFailedRepeatedlyAlert(taskId: string, failureCount: number): Promise<boolean> {
  return sendAlert(
    "🚨 AGENT ERROR",
    `Task #${taskId.slice(0, 8)} failed ${failureCount} times in a row.\n\nAgent paused for safety.`,
    "critical",
  );
}

// --- Revenue alerts (section 34-36, gated by notify_bounty_alerts) ---

export function bountyAwardedAlert(programName: string, amount: number, currency: string): Promise<boolean> {
  return sendAlert("💰 Bounty Awarded", `Program:\n${programName}\n\nAmount:\n${amount} ${currency}\n\n(Not yet PAID — this is not confirmed revenue.)`, "important", "bountyAlerts");
}

export interface PaidAlertGoalProgress {
  name: string;
  before: number;
  after: number;
}

/** Deliberately omits verificationStatus from the headline claim if UNVERIFIED — see the body text (section 35). */
export function bountyPaidAlert(programName: string, amount: number, currency: string, verified: boolean, goalDelta?: PaidAlertGoalProgress): Promise<boolean> {
  const lines = [
    `Program:\n${programName}`,
    "",
    `Amount:\n${amount} ${currency}`,
    "",
    `Confirmed Revenue:\n${verified ? `${amount} ${currency}` : "UNVERIFIED — no external confirmation source recorded"}`,
  ];
  if (goalDelta) {
    lines.push("", `Goal Progress:\n${goalDelta.name}: ${goalDelta.before}% → ${goalDelta.after}%`);
  }
  return sendAlert("🎉 BOUNTY PAID", lines.join("\n"), "important", "bountyAlerts");
}

export function bountyCancelledAlert(programName: string, amount: number | null, currency: string | null): Promise<boolean> {
  return sendAlert("⚠️ Bounty Cancelled", `Program:\n${programName}${amount !== null ? `\n\nWas:\n${amount} ${currency}` : ""}`, "important", "bountyAlerts");
}

// --- Goal alerts (section 33-34, gated by notify_goal_alerts) ---

export function goalMilestoneAlert(goalName: string, percent: number): Promise<boolean> {
  return sendAlert("🎯 GOAL PROGRESS", `"${goalName}" reached ${percent}% of target.`, "important", "goalAlerts");
}

// --- Finding alerts (gated by notify_finding_alerts) ---

export function findingCandidateAlert(title: string, programName: string): Promise<boolean> {
  return sendAlert("🐛 New Candidate Finding", `${title}\n\nProgram:\n${programName}`, "all", "findingAlerts");
}

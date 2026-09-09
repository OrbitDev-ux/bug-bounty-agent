import { getDb } from "../db/client.js";
import type { AgentSettings, NotificationLevel, NotificationPreferences } from "./types.js";

const SINGLETON_ID = "singleton";

interface SettingsRow {
  ai_model: string;
  notification_level: string;
  daily_summary_enabled: number;
  agent_auto_start: number;
  research_enabled: number;
  notify_finding_alerts: number;
  notify_approval_alerts: number;
  notify_agent_errors: number;
  notify_bounty_alerts: number;
  notify_daily_summary: number;
  notify_weekly_summary: number;
  notify_goal_alerts: number;
  quiet_until: string | null;
  updated_at: string;
}

function rowToSettings(row: SettingsRow): AgentSettings {
  return {
    aiModel: row.ai_model,
    notificationLevel: row.notification_level as NotificationLevel,
    dailySummaryEnabled: row.daily_summary_enabled === 1,
    agentAutoStart: row.agent_auto_start === 1,
    researchEnabled: row.research_enabled === 1,
    notifications: {
      findingAlerts: row.notify_finding_alerts === 1,
      approvalAlerts: row.notify_approval_alerts === 1,
      agentErrors: row.notify_agent_errors === 1,
      bountyAlerts: row.notify_bounty_alerts === 1,
      dailySummary: row.notify_daily_summary === 1,
      weeklySummary: row.notify_weekly_summary === 1,
      goalAlerts: row.notify_goal_alerts === 1,
    },
    quietUntil: row.quiet_until,
    updatedAt: row.updated_at,
  };
}

/**
 * Global operator settings (section 12). No field here can weaken a safety
 * control — there is deliberately no "disable scope check" / "disable
 * approval" / "unrestricted automation" setting to read or write.
 */
export function getSettings(): AgentSettings {
  const db = getDb();
  let row = db.prepare("SELECT * FROM agent_settings WHERE id = ?").get(SINGLETON_ID) as unknown as SettingsRow | undefined;
  if (!row) {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agent_settings (id, updated_at) VALUES (?, ?)").run(SINGLETON_ID, now);
    row = db.prepare("SELECT * FROM agent_settings WHERE id = ?").get(SINGLETON_ID) as unknown as SettingsRow;
  }
  return rowToSettings(row);
}

export interface UpdateSettingsInput {
  aiModel?: string;
  notificationLevel?: NotificationLevel;
  dailySummaryEnabled?: boolean;
  agentAutoStart?: boolean;
  researchEnabled?: boolean;
  notifications?: Partial<NotificationPreferences>;
  quietUntil?: string | null;
}

const NOTIFICATION_COLUMN_MAP: Record<keyof NotificationPreferences, string> = {
  findingAlerts: "notify_finding_alerts",
  approvalAlerts: "notify_approval_alerts",
  agentErrors: "notify_agent_errors",
  bountyAlerts: "notify_bounty_alerts",
  dailySummary: "notify_daily_summary",
  weeklySummary: "notify_weekly_summary",
  goalAlerts: "notify_goal_alerts",
};

const TOP_LEVEL_COLUMN_MAP: Record<string, string> = {
  aiModel: "ai_model",
  notificationLevel: "notification_level",
  dailySummaryEnabled: "daily_summary_enabled",
  agentAutoStart: "agent_auto_start",
  researchEnabled: "research_enabled",
};

export function updateSettings(input: UpdateSettingsInput): AgentSettings {
  getSettings(); // ensure row exists
  const db = getDb();
  const now = new Date().toISOString();

  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(TOP_LEVEL_COLUMN_MAP)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string));
  }

  if (input.notifications) {
    for (const [key, column] of Object.entries(NOTIFICATION_COLUMN_MAP) as [keyof NotificationPreferences, string][]) {
      const value = input.notifications[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value ? 1 : 0);
    }
  }

  if (input.quietUntil !== undefined) {
    sets.push("quiet_until = ?");
    values.push(input.quietUntil);
  }

  if (sets.length === 0) return getSettings();

  db.prepare(`UPDATE agent_settings SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, now, SINGLETON_ID);
  return getSettings();
}

/** Quiet mode (section 48): true while quietUntil is set and in the future. */
export function isQuiet(now: Date = new Date()): boolean {
  const settings = getSettings();
  if (!settings.quietUntil) return false;
  return new Date(settings.quietUntil).getTime() > now.getTime();
}

export function setQuietUntil(untilIso: string | null): AgentSettings {
  return updateSettings({ quietUntil: untilIso });
}

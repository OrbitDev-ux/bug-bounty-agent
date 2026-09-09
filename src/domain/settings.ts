import { getDb } from "../db/client.js";
import type { AgentSettings, NotificationLevel } from "./types.js";

const SINGLETON_ID = "singleton";

interface SettingsRow {
  ai_model: string;
  notification_level: string;
  daily_summary_enabled: number;
  agent_auto_start: number;
  research_enabled: number;
  updated_at: string;
}

function rowToSettings(row: SettingsRow): AgentSettings {
  return {
    aiModel: row.ai_model,
    notificationLevel: row.notification_level as NotificationLevel,
    dailySummaryEnabled: row.daily_summary_enabled === 1,
    agentAutoStart: row.agent_auto_start === 1,
    researchEnabled: row.research_enabled === 1,
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
}

const ALLOWED_KEYS: (keyof UpdateSettingsInput)[] = [
  "aiModel",
  "notificationLevel",
  "dailySummaryEnabled",
  "agentAutoStart",
  "researchEnabled",
];

export function updateSettings(input: UpdateSettingsInput): AgentSettings {
  getSettings(); // ensure row exists
  const db = getDb();
  const now = new Date().toISOString();

  const columnMap: Record<string, string> = {
    aiModel: "ai_model",
    notificationLevel: "notification_level",
    dailySummaryEnabled: "daily_summary_enabled",
    agentAutoStart: "agent_auto_start",
    researchEnabled: "research_enabled",
  };

  const sets: string[] = [];
  const values: (string | number)[] = [];
  for (const key of ALLOWED_KEYS) {
    if (input[key] === undefined) continue;
    sets.push(`${columnMap[key]} = ?`);
    const value = input[key];
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as string));
  }
  if (sets.length === 0) return getSettings();

  db.prepare(`UPDATE agent_settings SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, now, SINGLETON_ID);
  return getSettings();
}

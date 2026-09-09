import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { RevenueAuditEntry } from "./types.js";

interface RevenueAuditRow {
  id: string;
  earning_id: string;
  who: string;
  what: string;
  source: string;
  previous_value: string | null;
  new_value: string | null;
  reason: string;
  created_at: string;
}

function rowToEntry(row: RevenueAuditRow): RevenueAuditEntry {
  return {
    id: row.id,
    earningId: row.earning_id,
    who: row.who,
    what: row.what,
    source: row.source as RevenueAuditEntry["source"],
    previousValue: row.previous_value,
    newValue: row.new_value,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export interface RecordRevenueAuditInput {
  earningId: string;
  who: string;
  what: string;
  source: RevenueAuditEntry["source"];
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string;
}

/** Every revenue-affecting change gets one of these (section 39) — who/what/when/source/previous/new/reason. */
export function recordRevenueAudit(input: RecordRevenueAuditInput): RevenueAuditEntry {
  const db = getDb();
  const entry: RevenueAuditEntry = {
    id: randomUUID(),
    earningId: input.earningId,
    who: input.who,
    what: input.what,
    source: input.source,
    previousValue: input.previousValue !== undefined ? JSON.stringify(input.previousValue) : null,
    newValue: input.newValue !== undefined ? JSON.stringify(input.newValue) : null,
    reason: input.reason ?? "",
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO revenue_audit (id, earning_id, who, what, source, previous_value, new_value, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.id, entry.earningId, entry.who, entry.what, entry.source, entry.previousValue, entry.newValue, entry.reason, entry.createdAt);
  return entry;
}

export function listRevenueAuditForEarning(earningId: string): RevenueAuditEntry[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM revenue_audit WHERE earning_id = ? ORDER BY created_at ASC").all(earningId) as unknown as RevenueAuditRow[];
  return rows.map(rowToEntry);
}

export function listRecentRevenueAudit(limit = 50): RevenueAuditEntry[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM revenue_audit ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as RevenueAuditRow[];
  return rows.map(rowToEntry);
}

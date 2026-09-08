import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { BountyStatus, Earning } from "./types.js";

interface EarningRow {
  id: string;
  finding_id: string;
  program_id: string;
  bounty_status: string;
  amount: number | null;
  currency: string | null;
  awarded_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToEarning(row: EarningRow): Earning {
  return {
    id: row.id,
    findingId: row.finding_id,
    programId: row.program_id,
    bountyStatus: row.bounty_status as BountyStatus,
    amount: row.amount,
    currency: row.currency,
    awardedAt: row.awarded_at,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateEarningInput {
  findingId: string;
  programId: string;
  bountyStatus?: BountyStatus;
  amount?: number | null;
  currency?: string | null;
}

export function createEarning(input: CreateEarningInput): Earning {
  const db = getDb();
  const now = new Date().toISOString();
  const earning: Earning = {
    id: randomUUID(),
    findingId: input.findingId,
    programId: input.programId,
    bountyStatus: input.bountyStatus ?? "pending",
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    awardedAt: null,
    paidAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO earnings (id, finding_id, program_id, bounty_status, amount, currency, awarded_at, paid_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(earning.id, earning.findingId, earning.programId, earning.bountyStatus, earning.amount, earning.currency, earning.awardedAt, earning.paidAt, earning.createdAt, earning.updatedAt);
  return earning;
}

export interface MarkAwardedInput {
  amount: number;
  currency: string;
}

export function markAwarded(id: string, input: MarkAwardedInput): Earning {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE earnings SET bounty_status = 'awarded', amount = ?, currency = ?, awarded_at = ?, updated_at = ? WHERE id = ?",
  ).run(input.amount, input.currency, now, now, id);
  return mustGetEarning(id);
}

/** Only `paid` counts toward realized income (Accepted != Paid, per the project brief). */
export function markPaid(id: string): Earning {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE earnings SET bounty_status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  return mustGetEarning(id);
}

export function getEarning(id: string): Earning | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM earnings WHERE id = ?").get(id) as EarningRow | undefined;
  return row ? rowToEarning(row) : null;
}

function mustGetEarning(id: string): Earning {
  const e = getEarning(id);
  if (!e) throw new Error(`Earning not found: ${id}`);
  return e;
}

export function listEarnings(): Earning[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM earnings ORDER BY created_at DESC").all() as unknown as EarningRow[];
  return rows.map(rowToEarning);
}

export interface EarningsSummary {
  today: number;
  thisMonth: number;
  allTime: number;
  pending: number;
  paid: number;
}

/**
 * Only bountyStatus === "paid" rows contribute to today/thisMonth/allTime/paid.
 * `pending` sums amounts still awaiting payout (pending + awarded), for visibility only.
 */
export function summarizeEarnings(now: Date = new Date()): EarningsSummary {
  const earnings = listEarnings();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let today = 0;
  let thisMonth = 0;
  let allTime = 0;
  let pending = 0;
  let paid = 0;

  for (const e of earnings) {
    const amount = e.amount ?? 0;
    if (e.bountyStatus === "pending" || e.bountyStatus === "awarded") {
      pending += amount;
    }
    if (e.bountyStatus === "paid") {
      paid += amount;
      allTime += amount;
      if (e.paidAt) {
        const paidAt = new Date(e.paidAt);
        if (paidAt >= startOfMonth) thisMonth += amount;
        if (paidAt >= startOfDay) today += amount;
      }
    }
  }

  return { today, thisMonth, allTime, pending, paid };
}

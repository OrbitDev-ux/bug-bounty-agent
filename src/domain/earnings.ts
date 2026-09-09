import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { BountyStatus, Earning, VerificationStatus } from "./types.js";

interface EarningRow {
  id: string;
  finding_id: string;
  program_id: string;
  bounty_status: string;
  amount: number | null;
  currency: string | null;
  awarded_at: string | null;
  paid_at: string | null;
  verification_source: string | null;
  verification_status: string;
  exchange_rate: number | null;
  rate_source: string | null;
  rate_timestamp: string | null;
  external_submission_id: string | null;
  external_bounty_id: string | null;
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
    verificationSource: row.verification_source,
    verificationStatus: row.verification_status as VerificationStatus,
    exchangeRate: row.exchange_rate,
    rateSource: row.rate_source,
    rateTimestamp: row.rate_timestamp,
    externalSubmissionId: row.external_submission_id,
    externalBountyId: row.external_bounty_id,
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
  /** Dedup identity for a future real platform integration (section 45) — must be unique if set. */
  externalSubmissionId?: string | null;
  externalBountyId?: string | null;
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
    verificationSource: null,
    verificationStatus: "UNVERIFIED",
    exchangeRate: null,
    rateSource: null,
    rateTimestamp: null,
    externalSubmissionId: input.externalSubmissionId ?? null,
    externalBountyId: input.externalBountyId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO earnings (id, finding_id, program_id, bounty_status, amount, currency, awarded_at, paid_at, verification_status, external_submission_id, external_bounty_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    earning.id,
    earning.findingId,
    earning.programId,
    earning.bountyStatus,
    earning.amount,
    earning.currency,
    earning.awardedAt,
    earning.paidAt,
    earning.verificationStatus,
    earning.externalSubmissionId,
    earning.externalBountyId,
    earning.createdAt,
    earning.updatedAt,
  );
  return earning;
}

/**
 * Idempotent lookup-or-create (section 45): if an earning with this external
 * submission id already exists, returns it unchanged rather than creating a
 * duplicate. Safe to call repeatedly for the same external event (e.g. a
 * retried webhook, once a real platform integration exists).
 */
export function findOrCreateEarningByExternalSubmissionId(externalSubmissionId: string, input: Omit<CreateEarningInput, "externalSubmissionId">): Earning {
  const db = getDb();
  const existingRow = db.prepare("SELECT * FROM earnings WHERE external_submission_id = ?").get(externalSubmissionId) as unknown as EarningRow | undefined;
  if (existingRow) return rowToEarning(existingRow);
  return createEarning({ ...input, externalSubmissionId });
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

/**
 * Only `paid` counts toward realized income (Accepted != Paid, per the
 * project brief). `verificationSource` is optional — omitting it leaves
 * `verificationStatus: 'UNVERIFIED'` (section 24-25: no external
 * confirmation source means UNVERIFIED, regardless of bountyStatus).
 */
export function markPaid(id: string, verificationSource?: string): Earning {
  const existing = mustGetEarning(id);
  const finalSource = verificationSource ?? existing.verificationSource;
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE earnings SET bounty_status = 'paid', paid_at = ?, verification_source = ?, verification_status = ?, updated_at = ? WHERE id = ?",
  ).run(now, finalSource, finalSource ? "VERIFIED" : "UNVERIFIED", now, id);
  return mustGetEarning(id);
}

/** Records currency-conversion metadata (section 23) — the original amount/currency are never overwritten. */
export function recordExchangeRate(id: string, exchangeRate: number, rateSource: string): Earning {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE earnings SET exchange_rate = ?, rate_source = ?, rate_timestamp = ?, updated_at = ? WHERE id = ?").run(
    exchangeRate,
    rateSource,
    now,
    now,
    id,
  );
  return mustGetEarning(id);
}

export function getEarning(id: string): Earning | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM earnings WHERE id = ?").get(id) as unknown as EarningRow | undefined;
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
 * Nominal sum across all currencies (kept for v0.1/v0.2 compatibility — CLI
 * `earnings summary`, existing tests). Only bountyStatus === "paid" rows
 * contribute to today/thisMonth/allTime/paid; `pending` sums amounts still
 * awaiting payout (pending + awarded), for visibility only. Does NOT convert
 * currencies — if you have earnings in more than one currency, use
 * `summarizeEarningsByCurrency()` instead for a figure that isn't
 * misleadingly mixing e.g. USD and KRW into one number.
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

export interface CurrencyBucket {
  currency: string;
  paid: number;
  awarded: number;
  pending: number;
}

/**
 * Currency-correct breakdown (section 23) — never sums different currencies
 * together. `null`-currency earnings (created but not yet awarded) are
 * grouped under "UNSET" and excluded from any total.
 */
export function summarizeEarningsByCurrency(): CurrencyBucket[] {
  const earnings = listEarnings();
  const buckets = new Map<string, CurrencyBucket>();

  for (const e of earnings) {
    if (e.amount === null) continue;
    const currency = e.currency ?? "UNSET";
    const bucket = buckets.get(currency) ?? { currency, paid: 0, awarded: 0, pending: 0 };
    if (e.bountyStatus === "paid") bucket.paid += e.amount;
    else if (e.bountyStatus === "awarded") bucket.awarded += e.amount;
    else if (e.bountyStatus === "pending") bucket.pending += e.amount;
    buckets.set(currency, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

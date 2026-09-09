import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { Cost, CostCategory } from "./types.js";

interface CostRow {
  id: string;
  category: string;
  amount: number;
  currency: string;
  note: string;
  incurred_at: string;
}

function rowToCost(row: CostRow): Cost {
  return {
    id: row.id,
    category: row.category as CostCategory,
    amount: row.amount,
    currency: row.currency,
    note: row.note,
    incurredAt: row.incurred_at,
  };
}

export interface RecordCostInput {
  category: CostCategory;
  amount: number;
  currency?: string;
  note?: string;
}

/**
 * Records a REAL, measured cost — never an estimate (section 22). The
 * `claude_api` category is populated automatically from the actual
 * `costUsd` every `runClaude()` call reports (see src/services/costs.ts's
 * `recordClaudeCost` wrapper), not a guess.
 */
export function recordCost(input: RecordCostInput): Cost {
  const db = getDb();
  const cost: Cost = {
    id: randomUUID(),
    category: input.category,
    amount: input.amount,
    currency: input.currency ?? "USD",
    note: input.note ?? "",
    incurredAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO costs (id, category, amount, currency, note, incurred_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    cost.id,
    cost.category,
    cost.amount,
    cost.currency,
    cost.note,
    cost.incurredAt,
  );
  return cost;
}

export function listCosts(): Cost[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM costs ORDER BY incurred_at DESC").all() as unknown as CostRow[];
  return rows.map(rowToCost);
}

export interface CostSummaryByCurrency {
  currency: string;
  total: number;
  byCategory: Record<string, number>;
}

/** Currency-correct (section 23) — never mixes currencies into one number. */
export function summarizeCostsByCurrency(): CostSummaryByCurrency[] {
  const costs = listCosts();
  const buckets = new Map<string, CostSummaryByCurrency>();

  for (const c of costs) {
    const bucket = buckets.get(c.currency) ?? { currency: c.currency, total: 0, byCategory: {} };
    bucket.total += c.amount;
    bucket.byCategory[c.category] = (bucket.byCategory[c.category] ?? 0) + c.amount;
    buckets.set(c.currency, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

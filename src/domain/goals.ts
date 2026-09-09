import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import { summarizeEarningsByCurrency } from "./earnings.js";
import type { Goal } from "./types.js";

interface GoalRow {
  id: string;
  name: string;
  target_amount: number;
  target_currency: string;
  created_at: string;
  archived_at: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    name: row.name,
    targetAmount: row.target_amount,
    targetCurrency: row.target_currency,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

export interface CreateGoalInput {
  name: string;
  targetAmount: number;
  targetCurrency: string;
}

export function createGoal(input: CreateGoalInput): Goal {
  const db = getDb();
  const goal: Goal = {
    id: randomUUID(),
    name: input.name,
    targetAmount: input.targetAmount,
    targetCurrency: input.targetCurrency,
    createdAt: new Date().toISOString(),
    archivedAt: null,
  };
  db.prepare("INSERT INTO goals (id, name, target_amount, target_currency, created_at) VALUES (?, ?, ?, ?, ?)").run(
    goal.id,
    goal.name,
    goal.targetAmount,
    goal.targetCurrency,
    goal.createdAt,
  );
  return goal;
}

export function listGoals(includeArchived = false): Goal[] {
  const db = getDb();
  const rows = (
    includeArchived
      ? db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM goals WHERE archived_at IS NULL ORDER BY created_at DESC").all()
  ) as unknown as GoalRow[];
  return rows.map(rowToGoal);
}

export function archiveGoal(id: string): void {
  const db = getDb();
  db.prepare("UPDATE goals SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

export interface GoalProgress {
  goal: Goal;
  /** PAID earnings in the goal's own currency only (section 21/23 — no fabricated FX conversion). */
  paidInGoalCurrency: number;
  progressRatio: number; // 0.0-1.0+, always computed from PAID only
}

/** Progress is PAID-only, in the goal's exact currency — an earning in a different currency simply doesn't count unless converted with recorded rate metadata (see earnings.recordExchangeRate). */
export function getGoalProgress(goal: Goal): GoalProgress {
  const buckets = summarizeEarningsByCurrency();
  const bucket = buckets.find((b) => b.currency === goal.targetCurrency);
  const paidInGoalCurrency = bucket?.paid ?? 0;
  return {
    goal,
    paidInGoalCurrency,
    progressRatio: goal.targetAmount > 0 ? paidInGoalCurrency / goal.targetAmount : 0,
  };
}

export function listGoalProgress(): GoalProgress[] {
  return listGoals().map(getGoalProgress);
}

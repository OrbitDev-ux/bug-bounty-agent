import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.js";
import type { Approval, ApprovalDecision, ApprovalStatus } from "./types.js";

interface ApprovalRow {
  id: string;
  task_id: string | null;
  finding_id: string | null;
  status: string;
  requested_action: string;
  telegram_message_id: string | null;
  decided_by_telegram_user_id: string | null;
  decided_at: string | null;
  created_at: string;
}

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    taskId: row.task_id,
    findingId: row.finding_id,
    status: row.status as ApprovalStatus,
    requestedAction: row.requested_action,
    telegramMessageId: row.telegram_message_id,
    decidedByTelegramUserId: row.decided_by_telegram_user_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export interface CreateApprovalInput {
  taskId?: string | null;
  findingId?: string | null;
  requestedAction: string;
}

export function createApproval(input: CreateApprovalInput): Approval {
  const db = getDb();
  const now = new Date().toISOString();
  const approval: Approval = {
    id: randomUUID(),
    taskId: input.taskId ?? null,
    findingId: input.findingId ?? null,
    status: "pending",
    requestedAction: input.requestedAction,
    telegramMessageId: null,
    decidedByTelegramUserId: null,
    decidedAt: null,
    createdAt: now,
  };
  db.prepare(
    `INSERT INTO approvals (id, task_id, finding_id, status, requested_action, telegram_message_id, decided_by_telegram_user_id, decided_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(approval.id, approval.taskId, approval.findingId, approval.status, approval.requestedAction, approval.telegramMessageId, approval.decidedByTelegramUserId, approval.decidedAt, approval.createdAt);
  return approval;
}

export function getApproval(id: string): Approval | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  return row ? rowToApproval(row) : null;
}

export function listApprovals(status?: ApprovalStatus): Approval[] {
  const db = getDb();
  const rows = status
    ? (db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC").all(status) as unknown as ApprovalRow[])
    : (db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all() as unknown as ApprovalRow[]);
  return rows.map(rowToApproval);
}

export function setTelegramMessageId(id: string, telegramMessageId: string): void {
  const db = getDb();
  db.prepare("UPDATE approvals SET telegram_message_id = ? WHERE id = ?").run(telegramMessageId, id);
}

/**
 * Records a decision. Callers (the Telegram bot handler) MUST have already
 * verified the deciding user is on the allowlist before calling this —
 * this function trusts its `telegramUserId` argument completely.
 */
export function decideApproval(id: string, decision: ApprovalDecision, telegramUserId: string): Approval {
  const approval = getApproval(id);
  if (!approval) throw new Error(`Approval not found: ${id}`);
  if (approval.status !== "pending") {
    throw new Error(`Approval ${id} is already ${approval.status}, cannot decide again.`);
  }

  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE approvals SET status = ?, decided_by_telegram_user_id = ?, decided_at = ? WHERE id = ?",
  ).run(decision, telegramUserId, now, id);

  const updated = getApproval(id);
  if (!updated) throw new Error(`Approval disappeared: ${id}`);
  return updated;
}

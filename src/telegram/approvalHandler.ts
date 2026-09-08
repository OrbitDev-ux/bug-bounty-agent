import { isAllowedTelegramUser } from "./allowlist.js";
import { getApproval, decideApproval } from "../domain/approvals.js";
import { getTask, transitionTask } from "../domain/tasks.js";
import { log } from "../logging/logger.js";
import type { Approval, ApprovalDecision } from "../domain/types.js";

export interface HandleDecisionResult {
  ok: boolean;
  reason: string;
  approval?: Approval;
}

/**
 * Pure application logic for an incoming Telegram approve/reject callback —
 * deliberately separate from grammy's Context so it can be unit tested
 * without a live bot connection, and so the allowlist check can never be
 * accidentally skipped by a UI-layer change.
 */
export function handleApprovalDecision(
  approvalId: string,
  decision: ApprovalDecision,
  telegramUserId: string | number,
): HandleDecisionResult {
  if (!isAllowedTelegramUser(telegramUserId)) {
    log(decision === "approved" ? "approval_granted" : "approval_rejected", {
      approvalId,
      telegramUserId: String(telegramUserId),
      outcome: "denied_not_allowlisted",
    });
    return { ok: false, reason: "This Telegram account is not authorized to approve or reject." };
  }

  const approval = getApproval(approvalId);
  if (!approval) {
    return { ok: false, reason: "Unknown approval id." };
  }
  if (approval.status !== "pending") {
    return { ok: false, reason: `Already decided: ${approval.status}.` };
  }

  const decided = decideApproval(approvalId, decision, String(telegramUserId));

  if (decided.taskId) {
    const task = getTask(decided.taskId);
    if (task && task.status === "waiting_approval") {
      transitionTask(decided.taskId, decision === "approved" ? "approved" : "rejected");
    }
  }

  log(decision === "approved" ? "approval_granted" : "approval_rejected", {
    approvalId,
    telegramUserId: String(telegramUserId),
    taskId: decided.taskId,
    findingId: decided.findingId,
  });

  return { ok: true, reason: "Decision recorded.", approval: decided };
}

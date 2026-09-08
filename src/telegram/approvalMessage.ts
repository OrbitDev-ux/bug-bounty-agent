import type { Approval } from "../domain/types.js";

export interface ApprovalMessageContext {
  programName: string;
  asset: string;
  actionDescription: string;
}

export const CALLBACK_PREFIX = "approval";

export function approveCallbackData(approvalId: string): string {
  return `${CALLBACK_PREFIX}:${approvalId}:approve`;
}
export function rejectCallbackData(approvalId: string): string {
  return `${CALLBACK_PREFIX}:${approvalId}:reject`;
}
export function detailsCallbackData(approvalId: string): string {
  return `${CALLBACK_PREFIX}:${approvalId}:details`;
}

export interface ParsedCallback {
  approvalId: string;
  action: "approve" | "reject" | "details";
}

/** Returns null for anything that isn't one of our own approval callbacks. */
export function parseCallbackData(data: string): ParsedCallback | null {
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) return null;
  const [, approvalId, action] = parts;
  if (action !== "approve" && action !== "reject" && action !== "details") return null;
  if (!approvalId) return null;
  return { approvalId, action };
}

/** Renders the review card shown in section 11 of the project brief. */
export function formatApprovalMessage(approval: Approval, ctx: ApprovalMessageContext): string {
  return [
    "\u{1F50E} BUG BOUNTY REVIEW",
    "",
    `Program:\n${ctx.programName}`,
    "",
    `Asset:\n${ctx.asset}`,
    "",
    `Status:\nNeeds Approval`,
    "",
    `Action:\n${ctx.actionDescription}`,
  ].join("\n");
}

export function formatDecisionMessage(original: string, decision: "approved" | "rejected", byUserId: string): string {
  const stamp = decision === "approved" ? "✅ APPROVED" : "❌ REJECTED";
  return `${original}\n\n---\n${stamp} by Telegram user ${byUserId}`;
}

export function approvalInlineKeyboard(approvalId: string) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: approveCallbackData(approvalId) },
        { text: "❌ Reject", callback_data: rejectCallbackData(approvalId) },
      ],
      [{ text: "\u{1F4C4} Details", callback_data: detailsCallbackData(approvalId) }],
    ],
  };
}

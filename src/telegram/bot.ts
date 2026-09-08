import { Bot } from "grammy";
import { env, telegramConfigStatus } from "../config/env.js";
import { createApproval, setTelegramMessageId, getApproval } from "../domain/approvals.js";
import {
  formatApprovalMessage,
  formatDecisionMessage,
  approvalInlineKeyboard,
  parseCallbackData,
  type ApprovalMessageContext,
} from "./approvalMessage.js";
import { handleApprovalDecision } from "./approvalHandler.js";
import { log } from "../logging/logger.js";

let bot: Bot | null = null;

/** Lazily builds the bot instance. Throws with a clear message if unconfigured. */
export function getBot(): Bot {
  if (bot) return bot;
  const status = telegramConfigStatus();
  if (status !== "ready") {
    throw new Error(
      status === "missing_token"
        ? "TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in."
        : "TELEGRAM_ALLOWED_USER_IDS is not set — refusing to start without an approval allowlist.",
    );
  }
  bot = new Bot(env.telegramBotToken);
  wireHandlers(bot);
  return bot;
}

function wireHandlers(b: Bot): void {
  b.on("callback_query:data", async (ctx) => {
    const parsed = parseCallbackData(ctx.callbackQuery.data);
    if (!parsed) return; // not one of ours

    const telegramUserId = ctx.from.id;

    if (parsed.action === "details") {
      const approval = getApproval(parsed.approvalId);
      await ctx.answerCallbackQuery({
        text: approval ? `Requested: ${approval.requestedAction}`.slice(0, 200) : "Approval not found.",
        show_alert: true,
      });
      return;
    }

    const result = handleApprovalDecision(
      parsed.approvalId,
      parsed.action === "approve" ? "approved" : "rejected",
      telegramUserId,
    );

    await ctx.answerCallbackQuery({ text: result.reason });

    if (result.ok && ctx.callbackQuery.message) {
      const original = ctx.callbackQuery.message.text ?? "";
      await ctx.editMessageText(
        formatDecisionMessage(original, parsed.action === "approve" ? "approved" : "rejected", String(telegramUserId)),
      );
    }
  });
}

export interface RequestApprovalResult {
  approval: ReturnType<typeof createApproval>;
  delivered: boolean;
  deliveryError?: string;
}

/**
 * Creates a pending Approval row (the durable state that matters) and then
 * best-effort delivers the review card to every allowlisted Telegram chat.
 * The Approval record is NOT contingent on delivery succeeding — a human can
 * still act on it (e.g. via CLI/db) if Telegram isn't configured or the send
 * fails, so this never throws; it reports delivery failure in the result.
 */
export async function requestApproval(input: {
  taskId?: string | null;
  findingId?: string | null;
  requestedAction: string;
  context: ApprovalMessageContext;
}): Promise<RequestApprovalResult> {
  const approval = createApproval({
    taskId: input.taskId,
    findingId: input.findingId,
    requestedAction: input.requestedAction,
  });

  log("approval_requested", { approvalId: approval.id, taskId: approval.taskId, findingId: approval.findingId });

  const status = telegramConfigStatus();
  if (status !== "ready") {
    const deliveryError = status === "missing_token" ? "TELEGRAM_BOT_TOKEN not set" : "TELEGRAM_ALLOWED_USER_IDS not set";
    return { approval, delivered: false, deliveryError };
  }

  try {
    const b = getBot();
    const text = formatApprovalMessage(approval, input.context);
    const keyboard = approvalInlineKeyboard(approval.id);

    for (const chatId of env.telegramAllowedUserIds) {
      const sent = await b.api.sendMessage(chatId, text, { reply_markup: keyboard });
      setTelegramMessageId(approval.id, String(sent.message_id));
    }
    return { approval, delivered: true };
  } catch (err) {
    return { approval, delivered: false, deliveryError: (err as Error).message };
  }
}

export async function runTelegramBot(): Promise<void> {
  const b = getBot();
  log("agent_started", { component: "telegram_bot" });
  await b.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTelegramBot().catch((err) => {
    console.error("Telegram bot failed to start:", err.message);
    process.exit(1);
  });
}

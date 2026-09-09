import { Bot, InlineKeyboard } from "grammy";
import { env, telegramConfigStatus } from "../config/env.js";
import { createApproval, setTelegramMessageId, getApproval } from "../domain/approvals.js";
import {
  formatApprovalMessage,
  formatFindingReviewMessage,
  formatDecisionMessage,
  approvalInlineKeyboard,
  parseCallbackData,
  type ApprovalMessageContext,
  type FindingReviewContext,
} from "./approvalMessage.js";
import { handleApprovalDecision } from "./approvalHandler.js";
import { isAllowedTelegramUser } from "./allowlist.js";
import { log } from "../logging/logger.js";
import { listTasks } from "../domain/tasks.js";
import { listFindings } from "../domain/findings.js";
import { listApprovals } from "../domain/approvals.js";
import { listPrograms } from "../domain/programs.js";
import { summarizeEarnings } from "../domain/earnings.js";
import { getSettings, updateSettings } from "../domain/settings.js";
import { getSchedulerState } from "../domain/schedulerState.js";
import { listResearchSessions } from "../domain/researchSessions.js";
import { buildDailySummary, formatDailySummaryMessage } from "./dailySummary.js";
import { handleChatText, switchToFreechat, switchToAgentChat, confirmControlAction } from "./chatHandler.js";
import * as safari from "../safari/controller.js";
import type { Capability } from "../domain/types.js";

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

const HELP_TEXT = [
  "Bug Bounty Agent commands:",
  "",
  "/status — agent status, queue, approvals",
  "/tasks — recent tasks",
  "/findings — recent findings",
  "/approvals — pending approvals (with buttons)",
  "/programs — tracked programs",
  "/earnings — paid/pending revenue",
  "/settings — view/change safe operator settings",
  "/pause, /resume — control the scheduler",
  "/chat — AI chat grounded in live agent state (allowlisted users only)",
  "/freechat — general AI conversation, no agent data or actions",
].join("\n");

function requireAllowlisted(telegramUserId: number): boolean {
  return isAllowedTelegramUser(telegramUserId);
}

function wireHandlers(b: Bot): void {
  b.command("start", async (ctx) => {
    const allowed = ctx.from ? requireAllowlisted(ctx.from.id) : false;
    await ctx.reply(
      allowed
        ? "Bug Bounty Agent connected. /help for commands, /status to check the agent, or just talk via /chat."
        : "This bot only accepts commands from its configured allowlist. Ask the operator to add your Telegram user id to TELEGRAM_ALLOWED_USER_IDS. You can still use /freechat.",
    );
  });

  b.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  b.command("status", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(await renderStatus());
  });

  b.command("tasks", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const tasks = listTasks().slice(0, 10);
    if (tasks.length === 0) return void ctx.reply("No tasks.");
    await ctx.reply(tasks.map((t) => `${t.type} [${t.status}] ${t.target}`).join("\n"));
  });

  b.command("findings", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const findings = listFindings().slice(0, 10);
    if (findings.length === 0) return void ctx.reply("No findings.");
    await ctx.reply(findings.map((f) => `${f.title} [${f.status}]${f.duplicateVerdict ? ` (${f.duplicateVerdict})` : ""}`).join("\n"));
  });

  b.command("approvals", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const pending = listApprovals("pending");
    if (pending.length === 0) return void ctx.reply("No pending approvals.");
    for (const a of pending.slice(0, 5)) {
      await ctx.reply(`#${a.id.slice(0, 8)}\n${a.requestedAction}`, { reply_markup: approvalInlineKeyboard(a.id) });
    }
  });

  b.command("programs", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const programs = listPrograms();
    if (programs.length === 0) return void ctx.reply("No programs.");
    await ctx.reply(programs.map((p) => `${p.name} [${p.status}] automation=${p.policy.automationAllowed}`).join("\n"));
  });

  b.command("earnings", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const s = summarizeEarnings();
    await ctx.reply(
      [`Today: $${s.today.toFixed(2)}`, `This month: $${s.thisMonth.toFixed(2)}`, `All time (paid): $${s.allTime.toFixed(2)}`, `Pending: $${s.pending.toFixed(2)}`].join("\n"),
    );
  });

  b.command("settings", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(renderSettings(), { reply_markup: settingsKeyboard() });
  });

  b.command("pause", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(await confirmControlAction("CONTROL_AGENT_PAUSE"));
  });

  b.command("resume", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(await confirmControlAction("CONTROL_AGENT_RESUME"));
  });

  b.command("chat", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply(switchToAgentChat(String(ctx.from.id)));
  });

  b.command("freechat", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply(switchToFreechat(String(ctx.from.id)));
  });

  b.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Control-action confirmations (from /chat's natural-language pause/resume flow — section 9).
    const controlMatch = data.match(/^control:(CONTROL_AGENT_PAUSE|CONTROL_AGENT_RESUME):confirm$/);
    if (controlMatch) {
      if (!requireAllowlisted(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: "Not authorized." });
        return;
      }
      const summary = await confirmControlAction(controlMatch[1] as Capability);
      await ctx.answerCallbackQuery({ text: summary });
      if (ctx.callbackQuery.message) {
        await ctx.editMessageText(`${ctx.callbackQuery.message.text ?? ""}\n\n-> ${summary}`);
      }
      return;
    }
    if (data === "control:cancel") {
      await ctx.answerCallbackQuery({ text: "Cancelled." });
      return;
    }

    if (data.startsWith("settings:")) {
      if (!requireAllowlisted(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: "Not authorized." });
        return;
      }
      const [, kind, value] = data.split(":");
      if (kind === "toggle" && (value === "dailySummaryEnabled" || value === "researchEnabled")) {
        const current = getSettings();
        updateSettings({ [value]: !current[value] });
      } else if (kind === "notif" && (value === "all" || value === "important" || value === "none")) {
        updateSettings({ notificationLevel: value });
      }
      await ctx.answerCallbackQuery({ text: "Updated." });
      if (ctx.callbackQuery.message) {
        await ctx.editMessageText(renderSettings(), { reply_markup: settingsKeyboard() });
      }
      return;
    }

    const parsed = parseCallbackData(data);
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

  // Plain-text messages (not slash commands) route through the chat handler
  // — FREECHAT/AGENT_CHAT mode is looked up per-user, section 34.
  b.on("message:text", async (ctx) => {
    if (!ctx.from || ctx.message.text.startsWith("/")) return;
    const reply = await handleChatText(String(ctx.from.id), ctx.message.text);
    if (reply.confirmCallbackData) {
      const keyboard = new InlineKeyboard().text("Confirm", reply.confirmCallbackData).text("Cancel", "control:cancel");
      await ctx.reply(reply.text, { reply_markup: keyboard });
    } else {
      await ctx.reply(reply.text);
    }
  });
}

function renderSettings(): string {
  const s = getSettings();
  return [
    "Settings:",
    `AI Model: ${s.aiModel}`,
    `Notifications: ${s.notificationLevel}`,
    `Daily Summary: ${s.dailySummaryEnabled ? "on" : "off"}`,
    `Agent Auto Start: ${s.agentAutoStart ? "on" : "off"}`,
    `Research Enabled: ${s.researchEnabled ? "on" : "off"}`,
    "",
    "(Scope checks, policy enforcement, and human approval gates are not configurable — always on.)",
  ].join("\n");
}

function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Toggle Daily Summary", "settings:toggle:dailySummaryEnabled")
    .text("Toggle Research", "settings:toggle:researchEnabled")
    .row()
    .text("Notifications: all", "settings:notif:all")
    .text("important", "settings:notif:important")
    .text("none", "settings:notif:none");
}

async function renderStatus(): Promise<string> {
  const scheduler = getSchedulerState();
  const queueDepth = listTasks("queued").length;
  const pendingApprovals = listApprovals("pending").length;
  const lastResearch = listResearchSessions()[0];

  let browserStatus = "UNKNOWN";
  try {
    await safari.currentTab();
    browserStatus = "AVAILABLE";
  } catch {
    browserStatus = "UNAVAILABLE";
  }

  return [
    `Agent: ${scheduler.status.toUpperCase()}`,
    `Current Task: ${scheduler.currentTaskId ? `#${scheduler.currentTaskId}` : "none"}`,
    `Queue: ${queueDepth}`,
    `Pending Approvals: ${pendingApprovals}`,
    `Browser: ${browserStatus}`,
    `Last Research: ${lastResearch ? `${lastResearch.goal} (${lastResearch.status})` : "none yet"}`,
  ].join("\n");
}

export interface RequestApprovalResult {
  approval: ReturnType<typeof createApproval>;
  delivered: boolean;
  deliveryError?: string;
}

async function deliverApprovalCard(
  approval: ReturnType<typeof createApproval>,
  text: string,
): Promise<RequestApprovalResult> {
  const status = telegramConfigStatus();
  if (status !== "ready") {
    const deliveryError = status === "missing_token" ? "TELEGRAM_BOT_TOKEN not set" : "TELEGRAM_ALLOWED_USER_IDS not set";
    return { approval, delivered: false, deliveryError };
  }

  try {
    const b = getBot();
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
  ttlHours?: number | null;
}): Promise<RequestApprovalResult> {
  const approval = createApproval({
    taskId: input.taskId,
    findingId: input.findingId,
    requestedAction: input.requestedAction,
    ttlHours: input.ttlHours,
  });
  log("approval_requested", { approvalId: approval.id, taskId: approval.taskId, findingId: approval.findingId });
  return deliverApprovalCard(approval, formatApprovalMessage(approval, input.context));
}

/** Same durability/delivery guarantees as requestApproval(), using the Finding Review card (section 17). */
export async function requestFindingApproval(input: {
  taskId?: string | null;
  findingId: string;
  requestedAction: string;
  context: FindingReviewContext;
  ttlHours?: number | null;
}): Promise<RequestApprovalResult> {
  const approval = createApproval({
    taskId: input.taskId,
    findingId: input.findingId,
    requestedAction: input.requestedAction,
    ttlHours: input.ttlHours,
  });
  log("approval_requested", { approvalId: approval.id, taskId: approval.taskId, findingId: approval.findingId, kind: "finding_review" });
  return deliverApprovalCard(approval, formatFindingReviewMessage(input.context));
}

export async function sendDailySummary(): Promise<RequestApprovalResult["delivered"]> {
  const status = telegramConfigStatus();
  if (status !== "ready") return false;
  const b = getBot();
  const text = formatDailySummaryMessage(buildDailySummary());
  for (const chatId of env.telegramAllowedUserIds) {
    await b.api.sendMessage(chatId, text);
  }
  return true;
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

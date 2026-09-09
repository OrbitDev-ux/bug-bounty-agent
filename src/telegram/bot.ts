import { Bot, InlineKeyboard, GrammyError } from "grammy";
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
import { listPrograms, getProgram } from "../domain/programs.js";
import { listGoalProgress } from "../domain/goals.js";
import { getSettings, updateSettings, setQuietUntil } from "../domain/settings.js";
import { getSchedulerState } from "../domain/schedulerState.js";
import { listResearchSessions } from "../domain/researchSessions.js";
import { listCandidates, getCandidate, compareCandidates, selectCandidate, cancelCandidate, toggleChecklistItem, confirmAuthorization } from "../domain/programCandidates.js";
import { discoverAndCreateCandidates, researchCandidate, activateCandidateForResearch } from "../services/programResearch.js";
import { runResearchTask } from "../agent/orchestrator.js";
import { getWorkerProcessStatus } from "../agent/workerProcess.js";
import { buildDailySummary, formatDailySummaryMessage, buildWeeklySummary, formatWeeklySummaryMessage } from "./dailySummary.js";
import { handleChatText, switchToFreechat, switchToAgentChat, confirmControlAction } from "./chatHandler.js";
import {
  mainMenuKeyboard,
  mainMenuText,
  formatFindingsList,
  formatFindingDetail,
  findingsFilterKeyboard,
  findingsPaginationKeyboard,
  formatProgramsList,
  formatProgramDetail,
  formatEarnings,
  earningsPeriodKeyboard,
  formatAnalytics,
  formatGoalsList,
  formatTasksList,
  formatCandidatesList,
  formatCandidateDetail,
  formatCandidateComparison,
  formatCandidateRecommendation,
  formatEnrollmentChecklist,
  enrollmentChecklistKeyboard,
  candidateActionKeyboard,
  candidateActivateConfirmKeyboard,
  EARNINGS_PERIODS,
  type EarningsPeriod,
  type FindingFilter,
} from "./views.js";
import * as safari from "../safari/controller.js";
import type { Capability, NotificationPreferences } from "../domain/types.js";

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
  // Without this, ANY unhandled error thrown inside ANY handler (a bad
  // Telegram API call, a domain function throwing, etc.) propagates out of
  // bot.start() and kills the entire long-running process — silently, with
  // no auto-restart, until someone notices the bot stopped responding. Real
  // incident: an `editMessageText` call whose new content happened to be
  // byte-identical to the current message (a harmless, common Telegram API
  // quirk) threw, had no handler, and took the whole bot down. One user
  // update failing must never take down the bot for every other update.
  bot.catch((err) => {
    log("agent_alert", { component: "telegram_bot", note: "unhandled error in a Telegram update handler — bot stays up", error: err.message });
    console.error("Telegram handler error (bot stays running):", err.error);
  });
  return bot;
}

const HELP_TEXT = [
  "Bug Bounty Agent — Mobile Control Center",
  "",
  "/start — main menu",
  "/status — agent status, queue, approvals",
  "/tasks — task queue",
  "/findings — findings (filterable, paginated)",
  "/approvals — pending approvals (with buttons)",
  "/programs — tracked (live, enrolled) programs",
  "/discover <topic> — search for public bug bounty programs (no live testing until you enroll)",
  "/candidates — programs found so far, with enrollment stage",
  "/candidate <id> — one candidate's detail + stage-appropriate actions",
  "/research <id> — deep-dive research a candidate (scope/policy/automation/reward)",
  "/compare — rank all candidates by decision-support score",
  "/recommend — top recommendation + alternatives, with action buttons",
  "/activate <id> — re-verify policy and go live (only once 'authorized'; asks to confirm)",
  "/liveresearch <program-id-or-name> <goal> — real Research Agent run against an already-live, enrolled program",
  "/earnings [today|week|month|lastmonth|90d|all] — revenue",
  "/analytics — funnel, conversion rates, top program/category",
  "/goals — revenue goal progress",
  "/settings — view/change safe operator settings",
  "/pause — stop the scheduler flag (a running worker process finishes its current task, then idles)",
  "/resume — un-pause AND actually start a worker process if none is running",
  "/run — start a bounded worker process right now (same real action as /resume, without implying anything was paused)",
  "/quiet [minutes], /unquiet — mute non-critical alerts",
  "/chat — AI chat grounded in live agent state (allowlisted users only)",
  "/freechat, /exit — general AI conversation, no agent data or actions",
].join("\n");

function requireAllowlisted(telegramUserId: number): boolean {
  return isAllowedTelegramUser(telegramUserId);
}

function wireHandlers(b: Bot): void {
  b.command("start", async (ctx) => {
    const allowed = ctx.from ? requireAllowlisted(ctx.from.id) : false;
    if (!allowed) {
      await ctx.reply("This bot only accepts commands from its configured allowlist. Ask the operator to add your Telegram user id to TELEGRAM_ALLOWED_USER_IDS. You can still use /freechat.");
      return;
    }
    await ctx.reply(mainMenuText(), { reply_markup: mainMenuKeyboard() });
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
    await ctx.reply(formatTasksList(listTasks()));
  });

  b.command("findings", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await sendFindingsPage(ctx, "all", 0);
  });

  b.command("finding", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const ref = ctx.match?.toString().trim().replace(/^#/, "");
    const finding = ref ? listFindings().find((f) => f.id === ref || f.id.startsWith(ref)) : undefined;
    if (!finding) return void ctx.reply("Usage: /finding <id-or-prefix> — id shown in /findings.");
    const program = getProgram(finding.programId);
    await ctx.reply(formatFindingDetail(finding, program?.name ?? "unknown"));
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
    await ctx.reply(formatProgramsList(listPrograms()));
  });

  b.command("program", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const ref = ctx.match?.toString().trim();
    const program = ref ? listPrograms().find((p) => p.id === ref || p.id.startsWith(ref) || p.name.toLowerCase() === ref.toLowerCase()) : undefined;
    if (!program) return void ctx.reply("Usage: /program <id-or-name> — see /programs for the list.");
    await ctx.reply(formatProgramDetail(program));
  });

  b.command("discover", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const topic = ctx.match?.toString().trim();
    if (!topic) return void ctx.reply('Usage: /discover "<topic>" — e.g. /discover public bug bounty program automation friendly');
    await ctx.reply(`Searching for public programs on: "${topic}"... this reads real public web pages via Safari and can take a minute or two.`);
    const result = await discoverAndCreateCandidates(topic);
    if (!result.ok) return void ctx.reply(`Discovery failed: ${result.error ?? "unknown error"}`);
    await ctx.reply(
      `Found ${result.created.length} new candidate(s), ${result.deduped} already known. Use /candidates to see them, or /candidate <id> to research one in depth.\nCost: $${result.costUsd.toFixed(4)}`,
    );
  });

  b.command("candidates", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(formatCandidatesList(listCandidates()));
  });

  b.command("candidate", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const ref = ctx.match?.toString().trim();
    const candidate = findCandidateRef(ref);
    if (!candidate) return void ctx.reply("Usage: /candidate <id-or-prefix> — see /candidates for the list.");
    if (candidate.stage === "enrollment_pending") {
      await ctx.reply(formatEnrollmentChecklist(candidate), { reply_markup: enrollmentChecklistKeyboard(candidate) });
      return;
    }
    await ctx.reply(formatCandidateDetail(candidate), { reply_markup: candidateActionKeyboard(candidate) });
  });

  b.command("research", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const ref = ctx.match?.toString().trim();
    const candidate = findCandidateRef(ref);
    if (!candidate) return void ctx.reply("Usage: /research <candidate-id-or-prefix> — see /candidates for the list.");
    await runCandidateResearch(ctx, candidate.id);
  });

  b.command("compare", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(formatCandidateComparison(compareCandidates(listCandidates())));
  });

  b.command("recommend", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const ranked = compareCandidates(listCandidates());
    await ctx.reply(
      formatCandidateRecommendation(ranked.length, ranked),
      ranked.length > 0 ? { reply_markup: candidateActionKeyboard(ranked[0]!.candidate) } : undefined,
    );
  });

  b.command("activate", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const ref = ctx.match?.toString().trim();
    const candidate = findCandidateRef(ref);
    if (!candidate) return void ctx.reply("Usage: /activate <candidate-id-or-prefix> — see /candidates for the list.");
    if (candidate.stage !== "authorized") return void ctx.reply(`${candidate.name} is '${candidate.stage}', not 'authorized' — nothing to activate yet.`);
    await ctx.reply(
      `⚠️ This re-verifies ${candidate.name}'s published policy right now and creates a REAL, live-testable program. Confirm?`,
      { reply_markup: candidateActivateConfirmKeyboard(candidate.id) },
    );
  });

  b.command("liveresearch", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const raw = ctx.match?.toString().trim() ?? "";
    const spaceIdx = raw.indexOf(" ");
    const programRef = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
    const goal = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1).trim();
    if (!programRef || !goal) return void ctx.reply('Usage: /liveresearch <program-id-or-name> <goal> — see /programs for enrolled, live programs. This runs real Research Agent work against a live program.');
    const program = listPrograms().find((p) => p.id === programRef || p.id.startsWith(programRef) || p.name.toLowerCase() === programRef.toLowerCase());
    if (!program) return void ctx.reply("Program not found — see /programs. (Not enrolled anywhere yet? Use /discover first.)");
    await ctx.reply(`Researching ${program.name}: "${goal}"... this reads real public pages and can take a few minutes.`);
    const result = await runResearchTask({ programId: program.id, goal });
    await ctx.reply(
      `Task ${result.task.id.slice(0, 8)} -> ${result.task.status}\nCandidate findings: ${result.findingsCreated.length}${result.findingsCreated.length > 0 ? " (see /findings)" : ""}\nCost: $${result.costUsd.toFixed(4)}${!result.ok ? `\nError: ${result.error}` : ""}`,
    );
  });

  b.command("earnings", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const arg = ctx.match?.toString().trim().toLowerCase();
    const period: EarningsPeriod = (EARNINGS_PERIODS as readonly string[]).includes(arg ?? "") ? (arg as EarningsPeriod) : "all";
    await ctx.reply(formatEarnings(period), { reply_markup: earningsPeriodKeyboard(period) });
  });

  b.command("analytics", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(formatAnalytics());
  });

  b.command("goals", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(formatGoalsList(listGoalProgress()));
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

  b.command("run", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    await ctx.reply(await confirmControlAction("CONTROL_AGENT_START"));
  });

  b.command("quiet", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    const minutesArg = Number(ctx.match?.toString().trim());
    const minutes = Number.isFinite(minutesArg) && minutesArg > 0 ? minutesArg : 60;
    setQuietUntil(new Date(Date.now() + minutes * 60_000).toISOString());
    await ctx.reply(`🔇 Quiet for ${minutes} minute(s). Critical alerts (Safari down, repeated failures) still get through. Use /unquiet to cancel early.`);
  });

  b.command("unquiet", async (ctx) => {
    if (!ctx.from || !requireAllowlisted(ctx.from.id)) return void ctx.reply("Not authorized.");
    setQuietUntil(null);
    await ctx.reply("🔊 Quiet mode off.");
  });

  b.command("chat", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply(switchToAgentChat(String(ctx.from.id)));
  });

  b.command("freechat", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply(switchToFreechat(String(ctx.from.id)));
  });

  b.command("exit", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply(switchToAgentChat(String(ctx.from.id)));
  });

  b.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data === "noop") return void ctx.answerCallbackQuery();

    // Main menu (section 6) — each item re-delivers the equivalent command's content.
    const menuMatch = data.match(/^menu:(chat|research|approvals|tasks|findings|programs|earnings|analytics|settings|status)$/);
    if (menuMatch) {
      if (!requireAllowlisted(ctx.from.id)) return void ctx.answerCallbackQuery({ text: "Not authorized." });
      await ctx.answerCallbackQuery();
      await handleMenuSelection(ctx, menuMatch[1]!);
      return;
    }

    // Findings filter/pagination (section 14).
    const findingsFilterMatch = data.match(/^findings:filter:(.+)$/);
    if (findingsFilterMatch) {
      if (!requireAllowlisted(ctx.from.id)) return void ctx.answerCallbackQuery({ text: "Not authorized." });
      await ctx.answerCallbackQuery();
      await editFindingsPage(ctx, findingsFilterMatch[1] as FindingFilter, 0);
      return;
    }
    const findingsPageMatch = data.match(/^findings:page:(\d+):(.+)$/);
    if (findingsPageMatch) {
      if (!requireAllowlisted(ctx.from.id)) return void ctx.answerCallbackQuery({ text: "Not authorized." });
      await ctx.answerCallbackQuery();
      await editFindingsPage(ctx, findingsPageMatch[2] as FindingFilter, Number(findingsPageMatch[1]));
      return;
    }

    // Program candidate discovery / enrollment (v0.3.2, sections 13-18).
    if (data.startsWith("candidate:")) {
      if (!requireAllowlisted(ctx.from.id)) return void ctx.answerCallbackQuery({ text: "Not authorized." });
      const parts = data.split(":");
      const kind = parts[1];
      const telegramUserId = String(ctx.from.id);

      if (kind === "compare") {
        await ctx.answerCallbackQuery();
        await ctx.reply(formatCandidateComparison(compareCandidates(listCandidates())));
        return;
      }
      if (kind === "details") {
        const candidate = getCandidate(parts[2]!);
        await ctx.answerCallbackQuery();
        if (!candidate) return void ctx.reply("Candidate not found.");
        await ctx.reply(formatCandidateDetail(candidate), { reply_markup: candidateActionKeyboard(candidate) });
        return;
      }
      if (kind === "viewchecklist") {
        const candidate = getCandidate(parts[2]!);
        await ctx.answerCallbackQuery();
        if (!candidate) return void ctx.reply("Candidate not found.");
        await ctx.reply(formatEnrollmentChecklist(candidate), { reply_markup: enrollmentChecklistKeyboard(candidate) });
        return;
      }
      if (kind === "research") {
        await ctx.answerCallbackQuery({ text: "Researching — this reads the real public page and can take a minute or two." });
        await runCandidateResearch(ctx, parts[2]!);
        return;
      }
      if (kind === "activate") {
        const candidate = getCandidate(parts[2]!);
        await ctx.answerCallbackQuery();
        if (!candidate) return void ctx.reply("Candidate not found.");
        if (candidate.stage !== "authorized") return void ctx.reply(`${candidate.name} is '${candidate.stage}', not 'authorized' — nothing to activate yet.`);
        await ctx.reply(
          `⚠️ This re-verifies ${candidate.name}'s published policy right now and creates a REAL, live-testable program. Confirm?`,
          { reply_markup: candidateActivateConfirmKeyboard(candidate.id) },
        );
        return;
      }
      if (kind === "activate-cancel") {
        await ctx.answerCallbackQuery({ text: "Cancelled — nothing activated." });
        return;
      }
      if (kind === "activate-confirm") {
        await ctx.answerCallbackQuery({ text: "Activating — re-verifying the published policy now, this can take a minute or two." });
        const result = await activateCandidateForResearch(parts[2]!);
        if (!result.ok || !result.result) {
          await ctx.reply(`Activation failed: ${result.error ?? "unknown error"}`);
          return;
        }
        await ctx.reply(
          `🚀 LIVE: ${result.result.candidate.name}\n\nProgram: ${result.result.program.id} (status=${result.result.program.status})\nLive testing is now unblocked for this program. Cost: $${result.costUsd.toFixed(4)}`,
        );
        return;
      }
      if (kind === "select") {
        try {
          const updated = selectCandidate(parts[2]!, telegramUserId);
          await ctx.answerCallbackQuery({ text: "Selected — enrollment checklist below." });
          await ctx.reply(formatEnrollmentChecklist(updated), { reply_markup: enrollmentChecklistKeyboard(updated) });
        } catch (err) {
          await ctx.answerCallbackQuery({ text: (err as Error).message, show_alert: true });
        }
        return;
      }
      if (kind === "cancel") {
        const result = cancelCandidate(parts[2]!, `Cancelled via Telegram by ${telegramUserId}`);
        await ctx.answerCallbackQuery({ text: result.reason });
        return;
      }
      if (kind === "checklist") {
        try {
          const updated = toggleChecklistItem(parts[2]!, Number(parts[3]));
          await ctx.answerCallbackQuery();
          if (ctx.callbackQuery.message) {
            await safeEditMessageText(ctx, formatEnrollmentChecklist(updated), { reply_markup: enrollmentChecklistKeyboard(updated) });
          }
        } catch (err) {
          await ctx.answerCallbackQuery({ text: (err as Error).message, show_alert: true });
        }
        return;
      }
      if (kind === "authorize") {
        try {
          const updated = confirmAuthorization(parts[2]!, telegramUserId);
          await ctx.answerCallbackQuery({ text: "Recorded as self-reported enrollment. Not independently verified." });
          await ctx.reply(
            `✅ ${updated.name} marked AUTHORIZED (self-reported by you, not independently verified).\n\nLive research is still BLOCKED until you tap Activate (re-verifies the published policy right now) — use /candidate ${updated.id.slice(0, 8)} or /activate ${updated.id.slice(0, 8)}.`,
            { reply_markup: candidateActionKeyboard(updated) },
          );
        } catch (err) {
          await ctx.answerCallbackQuery({ text: (err as Error).message, show_alert: true });
        }
        return;
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // Earnings period switch (section 21).
    const earningsPeriodMatch = data.match(/^earnings:period:(.+)$/);
    if (earningsPeriodMatch) {
      if (!requireAllowlisted(ctx.from.id)) return void ctx.answerCallbackQuery({ text: "Not authorized." });
      const period = earningsPeriodMatch[1] as EarningsPeriod;
      await ctx.answerCallbackQuery();
      if (ctx.callbackQuery.message) {
        await safeEditMessageText(ctx, formatEarnings(period), { reply_markup: earningsPeriodKeyboard(period) });
      }
      return;
    }

    // Control-action confirmations (from /chat's natural-language pause/resume flow — section 9).
    const controlMatch = data.match(/^control:(CONTROL_AGENT_PAUSE|CONTROL_AGENT_RESUME|CONTROL_AGENT_START):confirm$/);
    if (controlMatch) {
      if (!requireAllowlisted(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: "Not authorized." });
        return;
      }
      const summary = await confirmControlAction(controlMatch[1] as Capability);
      await ctx.answerCallbackQuery({ text: summary });
      if (ctx.callbackQuery.message) {
        await safeEditMessageText(ctx, `${ctx.callbackQuery.message.text ?? ""}\n\n-> ${summary}`);
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
        updateSettings({ [value]: !current[value as "dailySummaryEnabled" | "researchEnabled"] });
      } else if (kind === "notif" && (value === "all" || value === "important" || value === "none")) {
        updateSettings({ notificationLevel: value });
      } else if (kind === "notify" && value) {
        const current = getSettings();
        const key = value as keyof NotificationPreferences;
        updateSettings({ notifications: { [key]: !current.notifications[key] } });
      }
      await ctx.answerCallbackQuery({ text: "Updated." });
      if (ctx.callbackQuery.message) {
        await safeEditMessageText(ctx, renderSettings(), { reply_markup: settingsKeyboard() });
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
      await safeEditMessageText(
        ctx,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleMenuSelection(ctx: any, item: string): Promise<void> {
  switch (item) {
    case "chat":
      await ctx.reply(switchToAgentChat(String(ctx.from.id)));
      return;
    case "research":
      await ctx.reply(
        'Not enrolled in a real program yet? Use /discover "<topic>" to find public candidates, then /candidates to review them.\n\nAlready have a live program? /liveresearch <program-id-or-name> <goal> runs real Research Agent work against it.',
      );
      return;
    case "approvals": {
      const pending = listApprovals("pending");
      if (pending.length === 0) return void ctx.reply("No pending approvals.");
      for (const a of pending.slice(0, 5)) await ctx.reply(`#${a.id.slice(0, 8)}\n${a.requestedAction}`, { reply_markup: approvalInlineKeyboard(a.id) });
      return;
    }
    case "tasks":
      await ctx.reply(formatTasksList(listTasks()));
      return;
    case "findings":
      await sendFindingsPage(ctx, "all", 0);
      return;
    case "programs":
      await ctx.reply(formatProgramsList(listPrograms()));
      return;
    case "earnings":
      await ctx.reply(formatEarnings("all"), { reply_markup: earningsPeriodKeyboard("all") });
      return;
    case "analytics":
      await ctx.reply(formatAnalytics());
      return;
    case "settings":
      await ctx.reply(renderSettings(), { reply_markup: settingsKeyboard() });
      return;
    case "status":
      await ctx.reply(await renderStatus());
      return;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendFindingsPage(ctx: any, filter: FindingFilter, page: number): Promise<void> {
  const { text, totalPages } = formatFindingsList(listFindings(), filter, page);
  await ctx.reply(text, { reply_markup: findingsFilterKeyboard(filter) });
  if (totalPages > 1) {
    await ctx.reply(`Page ${page + 1}/${totalPages}`, { reply_markup: findingsPaginationKeyboard(filter, page, totalPages) });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function editFindingsPage(ctx: any, filter: FindingFilter, page: number): Promise<void> {
  const { text, totalPages } = formatFindingsList(listFindings(), filter, page);
  if (!ctx.callbackQuery.message) return;
  await safeEditMessageText(ctx, text, { reply_markup: totalPages > 1 ? findingsPaginationKeyboard(filter, page, totalPages) : findingsFilterKeyboard(filter) });
}

/**
 * ctx.editMessageText, but never throws for the harmless "message is not
 * modified" case (a common, expected outcome when a user re-taps a button
 * that doesn't change the rendered content) — every other error still
 * propagates normally. See the real incident note on getBot() above: this
 * exact error, unhandled, took the whole bot process down.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function safeEditMessageText(ctx: any, text: string, other?: any): Promise<void> {
  try {
    await ctx.editMessageText(text, other);
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes("message is not modified")) return;
    throw err;
  }
}

function findCandidateRef(ref: string | undefined) {
  if (!ref) return undefined;
  return listCandidates({ includeCancelled: true }).find((c) => c.id === ref || c.id.startsWith(ref));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runCandidateResearch(ctx: any, candidateId: string): Promise<void> {
  const result = await researchCandidate(candidateId);
  if (!result.ok || !result.candidate) {
    await ctx.reply(`Research failed: ${result.error ?? "unknown error"}`);
    return;
  }
  await ctx.reply(
    `🔬 ${result.candidate.name} researched -> stage=${result.candidate.stage}\nScope: ${result.candidate.scopeClarity}  Policy: ${result.candidate.policyClarity}  Automation: ${result.candidate.automationPolicy}\nCost: $${result.costUsd.toFixed(4)}`,
    { reply_markup: candidateActionKeyboard(result.candidate) },
  );
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
    "Alerts:",
    `  Findings: ${s.notifications.findingAlerts ? "on" : "off"}`,
    `  Approvals: ${s.notifications.approvalAlerts ? "on" : "off"}`,
    `  Agent Errors: ${s.notifications.agentErrors ? "on" : "off"} (critical alerts always get through regardless)`,
    `  Bounty: ${s.notifications.bountyAlerts ? "on" : "off"}`,
    `  Daily Summary: ${s.notifications.dailySummary ? "on" : "off"}`,
    `  Weekly Summary: ${s.notifications.weeklySummary ? "on" : "off"}`,
    `  Goals: ${s.notifications.goalAlerts ? "on" : "off"}`,
    s.quietUntil ? `\nQuiet until: ${s.quietUntil}` : "",
    "",
    "(Scope checks, policy enforcement, and human approval gates are not configurable — always on.)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Toggle Daily Summary", "settings:toggle:dailySummaryEnabled")
    .text("Toggle Research", "settings:toggle:researchEnabled")
    .row()
    .text("Notif: all", "settings:notif:all")
    .text("important", "settings:notif:important")
    .text("none", "settings:notif:none")
    .row()
    .text("💰 Bounty", "settings:notify:bountyAlerts")
    .text("🐛 Findings", "settings:notify:findingAlerts")
    .text("🎯 Goals", "settings:notify:goalAlerts")
    .row()
    .text("📊 Daily", "settings:notify:dailySummary")
    .text("📈 Weekly", "settings:notify:weeklySummary");
}

async function renderStatus(): Promise<string> {
  const scheduler = getSchedulerState();
  const queueDepth = listTasks("queued").length;
  const pendingApprovals = listApprovals("pending").length;
  const lastResearch = listResearchSessions()[0];
  const worker = getWorkerProcessStatus();

  let browserStatus = "UNKNOWN";
  try {
    await safari.currentTab();
    browserStatus = "AVAILABLE";
  } catch {
    browserStatus = "UNAVAILABLE";
  }

  const workerLine = worker.running
    ? `Worker Process: RUNNING (pid ${worker.pid})`
    : scheduler.status === "running"
      ? "Worker Process: NOT RUNNING ⚠️ (scheduler flag says running, but nothing is actually consuming the queue — use /run or /resume to actually start one)"
      : "Worker Process: not running";

  return [
    `Agent: ${scheduler.status.toUpperCase()}`,
    workerLine,
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

export async function sendWeeklySummary(): Promise<RequestApprovalResult["delivered"]> {
  const status = telegramConfigStatus();
  if (status !== "ready") return false;
  const b = getBot();
  const text = formatWeeklySummaryMessage(buildWeeklySummary());
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

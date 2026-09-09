import { classifyIntent } from "../agent/commandRouter.js";
import { executeCapability } from "../agent/capabilities.js";
import { buildAgentContext } from "../agent/chatContext.js";
import { freeChatReply, agentChatReply } from "../agent/chat.js";
import { getOrCreateChatSession, appendChatMessage, getRecentChatMessages, setChatMode } from "../domain/chatSessions.js";
import { isAllowedTelegramUser } from "./allowlist.js";
import { log } from "../logging/logger.js";
import type { Capability, Task, Finding, Approval, Program } from "../domain/types.js";

export interface ChatReply {
  text: string;
  /** Set only for a control action that needs an explicit Yes/No confirmation before executing (section 9). */
  confirmCallbackData?: string;
}

/**
 * User Intent -> Command Classification -> Permission Check -> Policy Check
 * -> Approval? -> Execute (section 9). This is the single entrypoint the
 * Telegram bot calls for any plain-text (non-slash-command) message.
 */
export async function handleChatText(telegramUserId: string, text: string): Promise<ChatReply> {
  const session = getOrCreateChatSession(telegramUserId);
  appendChatMessage(telegramUserId, "user", text);

  if (session.mode === "FREECHAT") {
    const history = getRecentChatMessages(telegramUserId).slice(0, -1); // exclude the message we just appended
    const result = await freeChatReply(history, text);
    appendChatMessage(telegramUserId, "assistant", result.reply);
    return { text: result.reply };
  }

  // AGENT_CHAT mode from here — this surface can see agent state and
  // trigger control/approval actions, so it requires the same allowlist as
  // Telegram approvals and the CLI's --telegram-user-id fallback.
  if (!isAllowedTelegramUser(telegramUserId)) {
    const reply = "This account isn't authorized for Agent Chat. Ask the operator to add your Telegram user id to TELEGRAM_ALLOWED_USER_IDS, or use /freechat for general conversation.";
    appendChatMessage(telegramUserId, "assistant", reply);
    return { text: reply };
  }

  const intent = classifyIntent(text);
  log("chat_intent_classified", { category: intent.category, capability: intent.capability });

  if (intent.category === "UNSAFE_ACTION") {
    const reply = [
      "I can't do that.",
      "This agent only acts within a program's published scope and policy, and anything that could affect an",
      "external system needs an explicit human approval first. Out-of-scope testing, credential theft, service",
      "disruption, and bypassing platform restrictions are hard-blocked, not something a chat message can unlock.",
    ].join(" ");
    appendChatMessage(telegramUserId, "assistant", reply);
    return { text: reply };
  }

  if (intent.category === "CONTROL_ACTION" && intent.capability) {
    // Never execute a control action straight from natural language — ask
    // for explicit confirmation via the same button-based flow approvals use.
    const actionLabel = intent.capability === "CONTROL_AGENT_PAUSE" ? "pause" : intent.capability === "CONTROL_AGENT_RESUME" ? "resume" : "start";
    const reply = `Do you want me to ${actionLabel} the agent? This will actually run a bounded worker process against the current task queue, not just flip a status flag.`;
    appendChatMessage(telegramUserId, "assistant", reply);
    return { text: reply, confirmCallbackData: `control:${intent.capability}:confirm` };
  }

  if (intent.category === "APPROVAL_ACTION" && intent.capability === "DECIDE_APPROVAL" && intent.args) {
    const result = await executeCapability("DECIDE_APPROVAL", { ...intent.args, telegramUserId });
    appendChatMessage(telegramUserId, "assistant", result.summary);
    return { text: result.summary };
  }

  if (intent.category === "READ_ONLY_QUERY" && intent.capability) {
    const result = await executeCapability(intent.capability);
    const reply = formatCapabilityReply(intent.capability, result.data);
    appendChatMessage(telegramUserId, "assistant", reply);
    return { text: reply };
  }

  // CHAT or UNKNOWN: open conversation, grounded in a small live context.
  const history = getRecentChatMessages(telegramUserId).slice(0, -1);
  const context = await buildAgentContext();
  const result = await agentChatReply(history, text, context);
  appendChatMessage(telegramUserId, "assistant", result.reply);
  return { text: result.reply };
}

/** Executed only after the user taps the confirmation button for a control action — never from raw text alone. */
export async function confirmControlAction(capability: Capability): Promise<string> {
  const result = await executeCapability(capability);
  return result.summary;
}

export function switchToFreechat(telegramUserId: string): string {
  setChatMode(telegramUserId, "FREECHAT");
  return "Switched to /freechat — general conversation, no agent data or actions here. Use /chat to come back.";
}

export function switchToAgentChat(telegramUserId: string): string {
  setChatMode(telegramUserId, "AGENT_CHAT");
  return "Switched to /chat — ask about status, tasks, findings, approvals, or earnings.";
}

function formatCapabilityReply(capability: Capability, data: unknown): string {
  switch (capability) {
    case "READ_STATUS": {
      const s = data as Awaited<ReturnType<typeof import("../services/dashboard.js").getAgentStatus>>;
      return [
        `Scheduler: ${s.schedulerStatus.toUpperCase()}`,
        `Current task: ${s.currentTaskId ?? "none"}`,
        `Queue: ${s.queueDepth}`,
        `Pending approvals: ${s.pendingApprovals}`,
        `Browser: ${s.browserAvailable ? "available" : "unavailable"}`,
        s.lastResearchGoal ? `Last research: ${s.lastResearchGoal}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "READ_APPROVALS": {
      const approvals = data as Approval[];
      if (approvals.length === 0) return "No pending approvals.";
      const lines = [`${approvals.length} pending approval(s):`, ""];
      for (const a of approvals) lines.push(`#${a.id.slice(0, 8)}\n${a.requestedAction}`);
      return lines.join("\n");
    }
    case "READ_EARNINGS": {
      const d = data as { summary: { today: number; thisMonth: number; allTime: number; pending: number } };
      return [
        `Today: $${d.summary.today.toFixed(2)}`,
        `This month: $${d.summary.thisMonth.toFixed(2)}`,
        `All time (paid): $${d.summary.allTime.toFixed(2)}`,
        `Pending (awarded, not yet paid): $${d.summary.pending.toFixed(2)}`,
      ].join("\n");
    }
    case "READ_TASKS": {
      const tasks = data as Task[];
      if (tasks.length === 0) return "No tasks.";
      return [`${tasks.length} task(s):`, ...tasks.slice(0, 5).map((t) => `${t.type} [${t.status}] ${t.target}`)].join("\n");
    }
    case "READ_FINDINGS": {
      const findings = data as Finding[];
      if (findings.length === 0) return "No findings.";
      return [`${findings.length} finding(s):`, ...findings.slice(0, 5).map((f) => `${f.title} [${f.status}]`)].join("\n");
    }
    case "READ_PROGRAMS": {
      const programs = data as Program[];
      if (programs.length === 0) return "No programs.";
      return [`${programs.length} program(s):`, ...programs.slice(0, 5).map((p) => `${p.name} [${p.status}]`)].join("\n");
    }
    default:
      return "Done.";
  }
}

import { runClaude } from "./claudeRuntime.js";
import type { ChatMessage } from "../domain/types.js";

/**
 * Both chat modes call `runClaude()` with NO `mcpConfigPath` and the same
 * hard tool disallowlist every other call in this project gets — chat never
 * gets direct Safari/tool access (section 11). Conversation history is
 * serialized into the prompt text itself; each call is a fresh, stateless
 * `claude -p` invocation (no `--resume` session tying to arbitrary Telegram
 * users).
 */

const CHAT_MAX_BUDGET_USD = 0.15;

function formatHistory(history: ChatMessage[]): string {
  if (history.length === 0) return "(no previous messages)";
  return history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
}

export interface ChatReplyResult {
  ok: boolean;
  reply: string;
  costUsd: number;
  error?: string;
}

/**
 * Free Chat (section 7): a completely general assistant. Deliberately does
 * NOT receive agent context or tools — Free Chat != Agent Control. If the
 * user asks something agent-shaped, the system prompt nudges them to /chat
 * rather than the model guessing at data it doesn't have.
 */
export async function freeChatReply(history: ChatMessage[], message: string): Promise<ChatReplyResult> {
  const prompt = [
    "You are a general-purpose, friendly conversational assistant reachable via a Telegram bot's /freechat mode.",
    "You are NOT connected to any bug bounty agent data, tools, or actions in this mode — you cannot see tasks,",
    "findings, approvals, or earnings, and you cannot control anything. If the user asks about any of that, briefly",
    "mention they can switch to /chat for it, then continue being conversational and helpful about whatever else",
    "they're asking. Keep replies concise — this is a phone chat, not an essay.",
    "",
    "Conversation so far:",
    formatHistory(history),
    "",
    `New message from the user: ${message}`,
  ].join("\n");

  const result = await runClaude({ prompt, maxBudgetUsd: CHAT_MAX_BUDGET_USD, timeoutMs: 60_000 });
  return { ok: result.ok, reply: result.ok ? result.text : "Sorry, I couldn't process that right now.", costUsd: result.costUsd, error: result.error };
}

/**
 * Agent Chat (section 8): grounded in a small, freshly-fetched slice of
 * agent state (never the whole DB — section 32). Still no tools attached;
 * this is a read-only conversational layer, not a way to reach Safari/MCP
 * or any capability directly. Structured intents (status/tasks/earnings/
 * control/approval) are handled by the Command Router before this is ever
 * called — this function is only for genuinely open-ended phrasing.
 */
export async function agentChatReply(history: ChatMessage[], message: string, agentContext: string): Promise<ChatReplyResult> {
  const prompt = [
    "You are the conversational assistant for a local Bug Bounty Agent, reachable via Telegram's /chat mode.",
    "Answer naturally using ONLY the context below — never invent data you don't have. If something isn't in the",
    "context, say you don't have that information rather than guessing. Keep replies concise — this is a phone chat.",
    "You have no ability to take any action yourself in this reply; you are only describing current state.",
    "",
    "Current agent context:",
    agentContext,
    "",
    "Conversation so far:",
    formatHistory(history),
    "",
    `New message from the user: ${message}`,
  ].join("\n");

  const result = await runClaude({ prompt, maxBudgetUsd: CHAT_MAX_BUDGET_USD, timeoutMs: 60_000 });
  return { ok: result.ok, reply: result.ok ? result.text : "Sorry, I couldn't process that right now.", costUsd: result.costUsd, error: result.error };
}

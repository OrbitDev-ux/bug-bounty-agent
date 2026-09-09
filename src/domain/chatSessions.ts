import { getDb } from "../db/client.js";
import type { ChatMessage, ChatMode, ChatSession } from "./types.js";

/** Bounded ring buffer — never grows unbounded (project brief section 35). */
const MAX_MESSAGES_PER_USER = 20;

interface ChatSessionRow {
  telegram_user_id: string;
  mode: string;
  updated_at: string;
}

function rowToSession(row: ChatSessionRow): ChatSession {
  return { telegramUserId: row.telegram_user_id, mode: row.mode as ChatMode, updatedAt: row.updated_at };
}

export function getChatSession(telegramUserId: string): ChatSession | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM chat_sessions WHERE telegram_user_id = ?").get(telegramUserId) as unknown as ChatSessionRow | undefined;
  return row ? rowToSession(row) : null;
}

/** Defaults a never-seen user to AGENT_CHAT mode (matches `/chat` being the primary interface; `/freechat` explicitly switches away from it). */
export function getOrCreateChatSession(telegramUserId: string): ChatSession {
  const existing = getChatSession(telegramUserId);
  if (existing) return existing;
  return setChatMode(telegramUserId, "AGENT_CHAT");
}

export function setChatMode(telegramUserId: string, mode: ChatMode): ChatSession {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO chat_sessions (telegram_user_id, mode, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  ).run(telegramUserId, mode, now);
  return { telegramUserId, mode, updatedAt: now };
}

interface ChatMessageRow {
  id: number;
  telegram_user_id: string;
  role: string;
  content: string;
  created_at: string;
}

function rowToMessage(row: ChatMessageRow): ChatMessage {
  return { id: row.id, telegramUserId: row.telegram_user_id, role: row.role as ChatMessage["role"], content: row.content, createdAt: row.created_at };
}

/** Appends a message, then prunes anything beyond MAX_MESSAGES_PER_USER (oldest first) — never an unbounded history. */
export function appendChatMessage(telegramUserId: string, role: ChatMessage["role"], content: string): void {
  const db = getDb();
  db.prepare("INSERT INTO chat_messages (telegram_user_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
    telegramUserId,
    role,
    content,
    new Date().toISOString(),
  );

  const excess = db
    .prepare(
      `SELECT id FROM chat_messages WHERE telegram_user_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?`,
    )
    .all(telegramUserId, MAX_MESSAGES_PER_USER) as unknown as { id: number }[];
  if (excess.length > 0) {
    const ids = excess.map((r) => r.id);
    db.prepare(`DELETE FROM chat_messages WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }
}

export function getRecentChatMessages(telegramUserId: string, limit = MAX_MESSAGES_PER_USER): ChatMessage[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM chat_messages WHERE telegram_user_id = ? ORDER BY id DESC LIMIT ?")
    .all(telegramUserId, limit) as unknown as ChatMessageRow[];
  return rows.map(rowToMessage).reverse(); // oldest first for prompt construction
}

export function clearChatHistory(telegramUserId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM chat_messages WHERE telegram_user_id = ?").run(telegramUserId);
}

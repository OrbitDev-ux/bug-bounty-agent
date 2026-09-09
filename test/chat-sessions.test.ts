import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import {
  getChatSession,
  getOrCreateChatSession,
  setChatMode,
  appendChatMessage,
  getRecentChatMessages,
  clearChatHistory,
} from "../src/domain/chatSessions.js";

beforeEach(() => {
  freshDb();
});

test("a never-seen user has no session until one is created", () => {
  assert.equal(getChatSession("111"), null);
});

test("getOrCreateChatSession defaults a new user to AGENT_CHAT", () => {
  const session = getOrCreateChatSession("111");
  assert.equal(session.mode, "AGENT_CHAT");
});

test("setChatMode switches modes and getOrCreateChatSession doesn't reset it", () => {
  setChatMode("111", "FREECHAT");
  const session = getOrCreateChatSession("111");
  assert.equal(session.mode, "FREECHAT");
});

test("chat messages accumulate in order and are returned oldest-first", () => {
  appendChatMessage("111", "user", "hello");
  appendChatMessage("111", "assistant", "hi there");
  appendChatMessage("111", "user", "how are you");

  const messages = getRecentChatMessages("111");
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.content, "hello");
  assert.equal(messages[2]?.content, "how are you");
});

test("chat history is a bounded ring buffer, never unbounded (section 35)", () => {
  for (let i = 0; i < 50; i++) {
    appendChatMessage("111", "user", `message ${i}`);
  }
  const messages = getRecentChatMessages("111", 1000); // ask for way more than the cap
  assert.ok(messages.length <= 20, `expected the history to be capped, got ${messages.length}`);
  // the most recent messages are the ones retained
  assert.equal(messages[messages.length - 1]?.content, "message 49");
});

test("chat history is isolated per Telegram user", () => {
  appendChatMessage("111", "user", "from user 111");
  appendChatMessage("222", "user", "from user 222");

  assert.equal(getRecentChatMessages("111").length, 1);
  assert.equal(getRecentChatMessages("222").length, 1);
  assert.equal(getRecentChatMessages("111")[0]?.content, "from user 111");
});

test("clearChatHistory removes only that user's messages", () => {
  appendChatMessage("111", "user", "a");
  appendChatMessage("222", "user", "b");
  clearChatHistory("111");
  assert.equal(getRecentChatMessages("111").length, 0);
  assert.equal(getRecentChatMessages("222").length, 1);
});

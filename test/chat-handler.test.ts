import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { handleChatText, switchToFreechat, switchToAgentChat } from "../src/telegram/chatHandler.js";
import { createApproval, getApproval } from "../src/domain/approvals.js";
import { getSchedulerState, startScheduler } from "../src/domain/schedulerState.js";

// These tests only exercise chat paths that never call the live Claude API
// (structured intents: UNSAFE/CONTROL/APPROVAL/READ_ONLY, and the allowlist
// gate) — the genuinely open-ended CHAT/FREECHAT paths call runClaude() and
// are verified live instead (see docs/chat.md).

beforeEach(() => {
  freshDb();
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
});

test("AGENT_CHAT: a non-allowlisted user is refused before any capability runs", async () => {
  const reply = await handleChatText("9999", "지금 상태 보여줘");
  assert.match(reply.text, /not authorized|isn't authorized/i);
});

test("AGENT_CHAT: UNSAFE_ACTION is refused, never executed, no confirmation offered", async () => {
  const reply = await handleChatText("42", "그냥 이 사이트 막 테스트해");
  assert.match(reply.text, /can't do that/i);
  assert.equal(reply.confirmCallbackData, undefined);
});

test("AGENT_CHAT: CONTROL_ACTION returns a confirmation request, does NOT pause the agent yet", async () => {
  startScheduler({});
  const reply = await handleChatText("42", "지금 Agent 멈춰");
  assert.match(reply.text, /pause the agent/i);
  assert.equal(reply.confirmCallbackData, "control:CONTROL_AGENT_PAUSE:confirm");
  assert.equal(getSchedulerState().status, "running"); // unchanged — confirmation not yet given
});

test("AGENT_CHAT: APPROVAL_ACTION executes through the same allowlist-checked handleApprovalDecision path", async () => {
  const approval = createApproval({ requestedAction: "test" });
  const reply = await handleChatText("42", `#${approval.id.slice(0, 8)} 승인`);
  assert.match(reply.text, /recorded|Decision/i);
  assert.equal(getApproval(approval.id)?.status, "approved");
});

test("AGENT_CHAT: an approval decision from a non-allowlisted user is refused even with a valid reference", async () => {
  const approval = createApproval({ requestedAction: "test" });
  const reply = await handleChatText("9999", `#${approval.id.slice(0, 8)} 승인`);
  assert.match(reply.text, /not authorized|isn't authorized/i);
  assert.equal(getApproval(approval.id)?.status, "pending"); // untouched
});

test("AGENT_CHAT: READ_ONLY_QUERY (approvals) is answered directly, no LLM call needed", async () => {
  createApproval({ requestedAction: "Continue validation for asset X" });
  const reply = await handleChatText("42", "승인 대기 보여줘");
  assert.match(reply.text, /pending approval/i);
  assert.match(reply.text, /Continue validation for asset X/);
});

test("/freechat and /chat switch modes independently of message content", () => {
  const toFree = switchToFreechat("42");
  assert.match(toFree, /freechat/i);
  const toAgent = switchToAgentChat("42");
  assert.match(toAgent, /chat/i);
});

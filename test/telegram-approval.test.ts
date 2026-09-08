import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { isAllowedTelegramUser } from "../src/telegram/allowlist.js";
import { parseCallbackData, approveCallbackData, rejectCallbackData, detailsCallbackData } from "../src/telegram/approvalMessage.js";
import { handleApprovalDecision } from "../src/telegram/approvalHandler.js";
import { createProgram } from "../src/domain/programs.js";
import { createTask, transitionTask, getTask } from "../src/domain/tasks.js";
import { createApproval } from "../src/domain/approvals.js";

test("isAllowedTelegramUser only allows listed ids", () => {
  assert.equal(isAllowedTelegramUser(111, "111,222"), true);
  assert.equal(isAllowedTelegramUser("222", "111,222"), true);
  assert.equal(isAllowedTelegramUser(333, "111,222"), false);
  assert.equal(isAllowedTelegramUser(111, undefined), false);
  assert.equal(isAllowedTelegramUser(111, ""), false);
});

test("parseCallbackData round-trips approve/reject/details", () => {
  assert.deepEqual(parseCallbackData(approveCallbackData("abc")), { approvalId: "abc", action: "approve" });
  assert.deepEqual(parseCallbackData(rejectCallbackData("abc")), { approvalId: "abc", action: "reject" });
  assert.deepEqual(parseCallbackData(detailsCallbackData("abc")), { approvalId: "abc", action: "details" });
});

test("parseCallbackData rejects malformed or foreign callback data", () => {
  assert.equal(parseCallbackData("not_ours:abc:approve"), null);
  assert.equal(parseCallbackData("approval:abc"), null);
  assert.equal(parseCallbackData("approval:abc:explode"), null);
  assert.equal(parseCallbackData("random garbage"), null);
});

let programId: string;
let taskId: string;
let approvalId: string;

function setup() {
  freshDb();
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const program = createProgram({
    name: "Test Program",
    platform: "self-hosted",
    url: "https://example.com",
    policy: {
      inScope: ["example.com"],
      outOfScope: [],
      allowedMethods: [],
      forbiddenMethods: [],
      automationAllowed: true,
      restrictions: [],
    },
  });
  programId = program.id;
  const task = createTask({ type: "research", programId, target: "example.com" });
  transitionTask(task.id, "running");
  transitionTask(task.id, "waiting_approval");
  taskId = task.id;
  const approval = createApproval({ taskId, requestedAction: "Continue validation" });
  approvalId = approval.id;
}

beforeEach(setup);

test("rejects a decision from a Telegram user not on the allowlist", () => {
  const result = handleApprovalDecision(approvalId, "approved", 9999);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not authorized/);
  assert.equal(getTask(taskId)?.status, "waiting_approval"); // task untouched
});

test("approving as an allowlisted user transitions the linked task to approved", () => {
  const result = handleApprovalDecision(approvalId, "approved", 42);
  assert.equal(result.ok, true);
  assert.equal(getTask(taskId)?.status, "approved");
});

test("rejecting as an allowlisted user transitions the linked task to rejected", () => {
  const result = handleApprovalDecision(approvalId, "rejected", 42);
  assert.equal(result.ok, true);
  assert.equal(getTask(taskId)?.status, "rejected");
});

test("a second decision on an already-decided approval is refused", () => {
  handleApprovalDecision(approvalId, "approved", 42);
  const second = handleApprovalDecision(approvalId, "rejected", 42);
  assert.equal(second.ok, false);
  assert.match(second.reason, /Already decided/);
  assert.equal(getTask(taskId)?.status, "approved"); // unchanged by the second attempt
});

test("unknown approval id is refused", () => {
  const result = handleApprovalDecision("does-not-exist", "approved", 42);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Unknown approval/);
});

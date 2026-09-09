import { test } from "node:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import { safeEditMessageText } from "../src/telegram/bot.js";

/**
 * Real incident: an unhandled `editMessageText` GrammyError ("message is
 * not modified" — thrown whenever the new content happens to be
 * byte-identical to the current message, a common, harmless outcome when a
 * user re-taps a button) had no error handler anywhere, propagated out of
 * bot.start(), and killed the entire long-running bot process. Fixed with
 * (1) a global bot.catch() so no single handler failure ever takes the
 * whole bot down, and (2) safeEditMessageText specifically swallowing this
 * one harmless, expected error at its source. This file covers (2) — pure
 * logic, no live Telegram connection needed. (1) can't be unit tested the
 * same way since it requires a live Bot instance; see docs/telegram.md.
 */

function makeGrammyError(description: string): GrammyError {
  return new GrammyError(
    `Call to 'editMessageText' failed! (400: Bad Request: ${description})`,
    { ok: false, error_code: 400, description: `Bad Request: ${description}` },
    "editMessageText",
    {},
  );
}

test("safeEditMessageText swallows 'message is not modified' — the exact error that took the bot down", async () => {
  const ctx = {
    editMessageText: async () => {
      throw makeGrammyError("message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
    },
  };
  await assert.doesNotReject(() => safeEditMessageText(ctx, "same text"));
});

test("safeEditMessageText still propagates a different GrammyError", async () => {
  const ctx = {
    editMessageText: async () => {
      throw makeGrammyError("message to edit not found");
    },
  };
  await assert.rejects(() => safeEditMessageText(ctx, "text"), /message to edit not found/);
});

test("safeEditMessageText still propagates a non-Telegram error (a real bug must never be silently swallowed)", async () => {
  const ctx = {
    editMessageText: async () => {
      throw new Error("some unrelated domain error");
    },
  };
  await assert.rejects(() => safeEditMessageText(ctx, "text"), /some unrelated domain error/);
});

test("safeEditMessageText passes through text/other and resolves normally on success", async () => {
  let called: [string, unknown] | null = null;
  const ctx = {
    editMessageText: async (text: string, other: unknown) => {
      called = [text, other];
    },
  };
  await safeEditMessageText(ctx, "hello", { reply_markup: "kb" });
  assert.deepEqual(called, ["hello", { reply_markup: "kb" }]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramConfigStatus } from "../src/config/env.js";

/**
 * Regression test for a real incident: once a developer's .env has a real
 * TELEGRAM_BOT_TOKEN, Node's automatic process.loadEnvFile('.env') means
 * EVERY process — including the test suite — sees real credentials unless
 * something explicitly strips them. A test exercising the approval/
 * notification path (e.g. createCandidateFindings -> requestFindingApproval)
 * then sent a live message to the operator's real Telegram chat during a
 * routine `pnpm test` run. Fixed in src/config/env.ts by clearing the
 * Telegram vars whenever NODE_TEST_CONTEXT is set (Node's test runner sets
 * this on every test process, regardless of invocation style). This test
 * exists so that fix can never silently regress.
 */
test("real Telegram credentials from .env never reach a test process", () => {
  assert.equal(telegramConfigStatus(), "missing_token");
});

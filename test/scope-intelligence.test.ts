import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateScope } from "../src/domain/scope.js";
import type { Program } from "../src/domain/types.js";

function program(overrides: Partial<Program["policy"]> = {}, programOverrides: Partial<Program> = {}): Program {
  return {
    id: "p1",
    name: "Example Program",
    platform: "self-hosted",
    url: "https://example.com/security",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    policy: {
      inScope: ["*.example.com", "example.com"],
      outOfScope: ["internal.example.com"],
      allowedMethods: ["read-only browsing"],
      forbiddenMethods: ["automated scanning"],
      automationAllowed: true,
      restrictions: [],
      ...overrides,
    },
    ...programOverrides,
  };
}

test("evaluateScope: ALLOW for a fresh, explicit in-scope match", () => {
  const result = evaluateScope(program(), "example.com");
  assert.equal(result.verdict, "ALLOW");
});

test("evaluateScope: DENY for an explicit out-of-scope match", () => {
  const result = evaluateScope(program(), "internal.example.com");
  assert.equal(result.verdict, "DENY");
});

test("evaluateScope: DENY when automation is not allowed (explicit prohibition, not uncertainty)", () => {
  const result = evaluateScope(program({ automationAllowed: false }), "example.com");
  assert.equal(result.verdict, "DENY");
});

test("evaluateScope: DENY when program is not active", () => {
  const result = evaluateScope(program({}, { status: "paused" }), "example.com");
  assert.equal(result.verdict, "DENY");
});

test("evaluateScope: DENY when target matches no in-scope pattern", () => {
  const result = evaluateScope(program(), "unrelated.org");
  assert.equal(result.verdict, "DENY");
});

test("evaluateScope: NEEDS_HUMAN_REVIEW when no in-scope entries are published at all", () => {
  const result = evaluateScope(program({ inScope: [] }), "example.com");
  assert.equal(result.verdict, "NEEDS_HUMAN_REVIEW");
});

test("evaluateScope: NEEDS_HUMAN_REVIEW when an otherwise-matching policy was verified too long ago", () => {
  const staleDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(); // 200 days ago
  const result = evaluateScope(program({}, { policyLastVerifiedAt: staleDate }), "example.com");
  assert.equal(result.verdict, "NEEDS_HUMAN_REVIEW");
  assert.match(result.reason, /verified/);
});

test("evaluateScope: ALLOW when policy was verified recently", () => {
  const freshDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
  const result = evaluateScope(program({}, { policyLastVerifiedAt: freshDate }), "example.com");
  assert.equal(result.verdict, "ALLOW");
});

test("evaluateScope: does not downgrade to NEEDS_HUMAN_REVIEW when freshness was never tracked (v0.1 fixtures)", () => {
  // policyLastVerifiedAt omitted entirely — treated as "not tracked", not "definitely stale".
  const result = evaluateScope(program(), "example.com");
  assert.equal(result.verdict, "ALLOW");
});

test("evaluateScope: DENY (out-of-scope) wins over a stale-policy downgrade", () => {
  const staleDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const result = evaluateScope(program({}, { policyLastVerifiedAt: staleDate }), "internal.example.com");
  assert.equal(result.verdict, "DENY");
});

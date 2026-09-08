import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScope, checkMethodAllowed } from "../src/domain/scope.js";
import type { Program } from "../src/domain/types.js";

function program(overrides: Partial<Program["policy"]> = {}, status: Program["status"] = "active"): Program {
  return {
    id: "p1",
    name: "Example Program",
    platform: "self-hosted",
    url: "https://example.com/security",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    policy: {
      inScope: ["*.example.com", "example.com"],
      outOfScope: ["internal.example.com"],
      allowedMethods: ["read-only browsing"],
      forbiddenMethods: ["automated scanning", "denial of service"],
      automationAllowed: true,
      restrictions: [],
      ...overrides,
    },
  };
}

test("allows an in-scope apex domain", () => {
  const decision = checkScope(program(), "example.com");
  assert.equal(decision.allowed, true);
});

test("allows an in-scope subdomain via wildcard", () => {
  const decision = checkScope(program(), "app.example.com");
  assert.equal(decision.allowed, true);
});

test("allows a full URL target by normalizing it", () => {
  const decision = checkScope(program(), "https://app.example.com/some/path?x=1");
  assert.equal(decision.allowed, true);
});

test("rejects an explicitly out-of-scope subdomain even though it matches the wildcard", () => {
  const decision = checkScope(program(), "internal.example.com");
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /out-of-scope/);
});

test("rejects a target that only superficially resembles the domain", () => {
  const decision = checkScope(program(), "notexample.com");
  assert.equal(decision.allowed, false);
});

test("rejects a target with no matching in-scope pattern", () => {
  const decision = checkScope(program(), "unrelated-domain.org");
  assert.equal(decision.allowed, false);
});

test("fails closed when automation is not allowed by policy", () => {
  const decision = checkScope(program({ automationAllowed: false }), "example.com");
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /automated tooling/);
});

test("fails closed when program has no published in-scope entries", () => {
  const decision = checkScope(program({ inScope: [] }), "example.com");
  assert.equal(decision.allowed, false);
});

test("rejects any target when program is paused", () => {
  const decision = checkScope(program({}, "paused"), "example.com");
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /status/);
});

test("checkMethodAllowed flags an action matching a forbidden method", () => {
  const decision = checkMethodAllowed(program(), "run automated scanning against the target");
  assert.equal(decision.allowed, false);
});

test("checkMethodAllowed permits an action with no forbidden-method match", () => {
  const decision = checkMethodAllowed(program(), "read public documentation");
  assert.equal(decision.allowed, true);
});

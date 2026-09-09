import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOriginOrNoOrigin } from "../src/web/server.js";
import type { IncomingMessage } from "node:http";

function fakeRequest(origin: string | undefined): IncomingMessage {
  return { headers: { origin } } as IncomingMessage;
}

test("no Origin header is allowed through (curl, scripts, some same-origin fetches)", () => {
  assert.equal(isSameOriginOrNoOrigin(fakeRequest(undefined), "127.0.0.1", 4173), true);
});

test("matching 127.0.0.1 origin is allowed", () => {
  assert.equal(isSameOriginOrNoOrigin(fakeRequest("http://127.0.0.1:4173"), "127.0.0.1", 4173), true);
});

test("matching localhost origin is allowed", () => {
  assert.equal(isSameOriginOrNoOrigin(fakeRequest("http://localhost:4173"), "127.0.0.1", 4173), true);
});

test("a cross-origin request (a malicious page open in the same browser) is rejected — CSRF mitigation", () => {
  assert.equal(isSameOriginOrNoOrigin(fakeRequest("http://evil.example"), "127.0.0.1", 4173), false);
});

test("a matching host but wrong port is rejected", () => {
  assert.equal(isSameOriginOrNoOrigin(fakeRequest("http://127.0.0.1:9999"), "127.0.0.1", 4173), false);
});

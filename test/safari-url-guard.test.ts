import { test } from "node:test";
import assert from "node:assert/strict";
import { assertHttpUrl, isBlockedHost } from "../src/safari/controller.js";

test("allows ordinary public https URLs", () => {
  assert.doesNotThrow(() => assertHttpUrl("https://example.com/security"));
  assert.doesNotThrow(() => assertHttpUrl("http://bounty.github.com/"));
});

test("rejects non-http(s) schemes (SSRF/local-execution guard, security audit section 40)", () => {
  assert.throws(() => assertHttpUrl("javascript:alert(1)"));
  assert.throws(() => assertHttpUrl("file:///etc/passwd"));
  assert.throws(() => assertHttpUrl("data:text/html,<script>1</script>"));
});

test("rejects malformed URLs", () => {
  assert.throws(() => assertHttpUrl("not a url"));
});

test("isBlockedHost flags loopback, private, and link-local hosts (SSRF hardening)", () => {
  assert.equal(isBlockedHost("localhost"), true);
  assert.equal(isBlockedHost("127.0.0.1"), true);
  assert.equal(isBlockedHost("127.5.5.5"), true);
  assert.equal(isBlockedHost("0.0.0.0"), true);
  assert.equal(isBlockedHost("10.0.0.5"), true);
  assert.equal(isBlockedHost("192.168.1.1"), true);
  assert.equal(isBlockedHost("172.16.0.1"), true);
  assert.equal(isBlockedHost("172.31.255.255"), true);
  assert.equal(isBlockedHost("169.254.169.254"), true); // cloud metadata
  assert.equal(isBlockedHost("::1"), true);
  assert.equal(isBlockedHost("fe80::1"), true);
  assert.equal(isBlockedHost("fd00::1"), true);
});

test("isBlockedHost does not flag ordinary public hosts or adjacent-looking public IPs", () => {
  assert.equal(isBlockedHost("example.com"), false);
  assert.equal(isBlockedHost("bounty.github.com"), false);
  assert.equal(isBlockedHost("172.32.0.1"), false); // just outside the 172.16/12 block
  assert.equal(isBlockedHost("8.8.8.8"), false);
});

test("assertHttpUrl refuses a URL whose host is a blocked private/loopback address", () => {
  assert.throws(() => assertHttpUrl("http://127.0.0.1:8080/"), /loopback\/private\/link-local/);
  assert.throws(() => assertHttpUrl("http://169.254.169.254/latest/meta-data/"), /loopback\/private\/link-local/);
  assert.throws(() => assertHttpUrl("http://localhost:3000/admin"), /loopback\/private\/link-local/);
});

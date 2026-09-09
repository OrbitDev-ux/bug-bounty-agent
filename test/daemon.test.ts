import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlist, DAEMON_LABEL } from "../src/agent/daemon.js";

test("generatePlist produces valid-looking plist XML with the expected label", () => {
  const plist = generatePlist("/tmp/some-project");
  assert.match(plist, /<\?xml version="1\.0"/);
  assert.match(plist, /<!DOCTYPE plist/);
  assert.match(plist, new RegExp(`<string>${DAEMON_LABEL}</string>`));
});

test("generatePlist points ProgramArguments at 'agent start --daemon', not an unbounded loop", () => {
  const plist = generatePlist("/tmp/some-project");
  assert.match(plist, /<string>agent<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.match(plist, /<string>--daemon<\/string>/);
});

test("generatePlist sets RunAtLoad and KeepAlive true, with a ThrottleInterval backoff floor (section 28)", () => {
  const plist = generatePlist("/tmp/some-project");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>300<\/integer>/);
});

test("generatePlist honors a custom throttle interval", () => {
  const plist = generatePlist("/tmp/some-project", 600);
  assert.match(plist, /<integer>600<\/integer>/);
});

test("generatePlist points WorkingDirectory at the resolved absolute project path", () => {
  const plist = generatePlist("./relative-project-dir");
  assert.doesNotMatch(plist, /<string>\.\/relative-project-dir<\/string>/);
  assert.match(plist, /<string>\/.*relative-project-dir<\/string>/);
});

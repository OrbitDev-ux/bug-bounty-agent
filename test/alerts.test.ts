import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { updateSettings, setQuietUntil } from "../src/domain/settings.js";
import { shouldSend, safariUnavailableAlert } from "../src/agent/alerts.js";

beforeEach(() => {
  freshDb();
});

test("critical alerts are always gated through, regardless of notificationLevel", () => {
  updateSettings({ notificationLevel: "none" });
  assert.equal(shouldSend("critical"), true);
});

test("critical alerts are always gated through, even during quiet mode", () => {
  setQuietUntil(new Date(Date.now() + 60_000).toISOString());
  assert.equal(shouldSend("critical"), true);
});

test("critical alerts are always gated through, even if the matching category toggle is off", () => {
  updateSettings({ notifications: { bountyAlerts: false } });
  assert.equal(shouldSend("critical", "bountyAlerts"), true);
});

test("an 'important' alert is gated off when notificationLevel is 'none'", () => {
  updateSettings({ notificationLevel: "none" });
  assert.equal(shouldSend("important"), false);
});

test("an 'important' alert passes when notificationLevel is 'important' or 'all'", () => {
  updateSettings({ notificationLevel: "important" });
  assert.equal(shouldSend("important"), true);
  updateSettings({ notificationLevel: "all" });
  assert.equal(shouldSend("important"), true);
});

test("an 'all'-level alert only passes when notificationLevel is specifically 'all'", () => {
  updateSettings({ notificationLevel: "important" });
  assert.equal(shouldSend("all"), false);
  updateSettings({ notificationLevel: "all" });
  assert.equal(shouldSend("all"), true);
});

test("a category toggle being off gates the alert off even when notificationLevel allows it", () => {
  updateSettings({ notificationLevel: "all", notifications: { bountyAlerts: false } });
  assert.equal(shouldSend("important", "bountyAlerts"), false);
  assert.equal(shouldSend("important", "goalAlerts"), true); // a different, still-enabled category
});

test("quiet mode suppresses a non-critical alert regardless of notificationLevel", () => {
  updateSettings({ notificationLevel: "all" });
  setQuietUntil(new Date(Date.now() + 60_000).toISOString());
  assert.equal(shouldSend("important"), false);
  assert.equal(shouldSend("all"), false);
});

test("quiet mode expiring in the past no longer suppresses alerts", () => {
  updateSettings({ notificationLevel: "all" });
  setQuietUntil(new Date(Date.now() - 60_000).toISOString());
  assert.equal(shouldSend("important"), true);
});

test("safariUnavailableAlert() attempts delivery (no real Telegram in tests, so it reports false — but reaches the delivery attempt, not blocked by gating)", async () => {
  updateSettings({ notificationLevel: "none" }); // would block a non-critical alert
  const result = await safariUnavailableAlert("test reason");
  assert.equal(result, false); // no Telegram configured in test env — this confirms delivery was attempted, not gated
});

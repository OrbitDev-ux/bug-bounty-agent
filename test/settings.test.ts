import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { getSettings, updateSettings } from "../src/domain/settings.js";

beforeEach(() => {
  freshDb();
});

test("getSettings returns safe defaults on first access", () => {
  const settings = getSettings();
  assert.equal(settings.aiModel, "sonnet");
  assert.equal(settings.notificationLevel, "important");
  assert.equal(settings.dailySummaryEnabled, true);
  assert.equal(settings.agentAutoStart, false);
  assert.equal(settings.researchEnabled, true);
});

test("updateSettings changes only the fields given", () => {
  updateSettings({ notificationLevel: "none" });
  const settings = getSettings();
  assert.equal(settings.notificationLevel, "none");
  assert.equal(settings.researchEnabled, true); // unchanged
});

test("updateSettings persists booleans correctly", () => {
  updateSettings({ dailySummaryEnabled: false, agentAutoStart: true });
  const settings = getSettings();
  assert.equal(settings.dailySummaryEnabled, false);
  assert.equal(settings.agentAutoStart, true);
});

test("AgentSettings has no field for disabling scope/approval/policy enforcement (section 12)", () => {
  const settings = getSettings();
  const keys = Object.keys(settings);
  for (const forbidden of ["disableScope", "disableApproval", "ignorePolicy", "unrestrictedAutomation", "approvalRequired"]) {
    assert.ok(!keys.includes(forbidden), `settings must not expose a "${forbidden}" toggle`);
  }
});

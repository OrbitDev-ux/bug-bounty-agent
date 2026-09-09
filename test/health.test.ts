import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { checkHealth } from "../src/services/health.js";

// No live Claude API spend here — `claude --version` and Safari's
// currentTab() are both free, fast, local checks (no paid tool-call turn),
// consistent with keeping paid/networked calls out of the automated suite.

test("checkHealth returns all six components and an overall status derived from them", async () => {
  freshDb();
  const report = await checkHealth();

  const names = report.checks.map((c) => c.component).sort();
  assert.deepEqual(names, ["Claude CLI", "Queue", "SQLite", "Safari", "Scheduler", "Telegram"].sort());

  assert.equal(report.checks.find((c) => c.component === "SQLite")?.status, "OK");

  const worstSeen = report.checks.some((c) => c.status === "FAILED")
    ? "FAILED"
    : report.checks.some((c) => c.status === "DEGRADED")
      ? "DEGRADED"
      : "OK";
  assert.equal(report.overall, worstSeen);
});

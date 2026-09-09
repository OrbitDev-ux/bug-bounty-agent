import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding } from "../src/domain/findings.js";
import { createEarning, markAwarded, markPaid } from "../src/domain/earnings.js";
import { createGoal } from "../src/domain/goals.js";
import { checkGoalMilestones } from "../src/domain/goalAlerts.js";
import type { Program } from "../src/domain/types.js";

let program: Program;

beforeEach(() => {
  freshDb();
  program = createProgram({
    name: "P",
    platform: "self-hosted",
    url: "https://example.com",
    policy: { inScope: ["example.com"], outOfScope: [], allowedMethods: [], forbiddenMethods: [], automationAllowed: true, restrictions: [] },
  });
});

function payFinding(amount: number, currency: string) {
  const finding = createFinding({ programId: program.id, title: "f", asset: "example.com" });
  const earning = createEarning({ findingId: finding.id, programId: program.id });
  markAwarded(earning.id, { amount, currency });
  markPaid(earning.id);
}

test("no milestones fire for a goal with 0% progress", () => {
  createGoal({ name: "Goal", targetAmount: 1000, targetCurrency: "USD" });
  assert.deepEqual(checkGoalMilestones(), []);
});

test("crossing 25% fires exactly the 25% milestone, not 50/75/100", () => {
  createGoal({ name: "Goal", targetAmount: 1000, targetCurrency: "USD" });
  payFinding(300, "USD"); // 30%

  const milestones = checkGoalMilestones();
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0]?.thresholdPct, 25);
});

test("crossing straight to 100% fires all four thresholds at once, each exactly once", () => {
  createGoal({ name: "Goal", targetAmount: 1000, targetCurrency: "USD" });
  payFinding(1000, "USD"); // 100%

  const milestones = checkGoalMilestones();
  assert.deepEqual(
    milestones.map((m) => m.thresholdPct).sort((a, b) => a - b),
    [25, 50, 75, 100],
  );
});

test("a threshold already crossed never fires again on a subsequent check (section 33)", () => {
  createGoal({ name: "Goal", targetAmount: 1000, targetCurrency: "USD" });
  payFinding(300, "USD"); // 30% -> crosses 25%
  checkGoalMilestones();

  const secondCheck = checkGoalMilestones();
  assert.deepEqual(secondCheck, []);
});

test("progressing further after an initial threshold only fires the newly crossed one", () => {
  createGoal({ name: "Goal", targetAmount: 1000, targetCurrency: "USD" });
  payFinding(300, "USD"); // 30%
  checkGoalMilestones(); // fires 25%

  payFinding(300, "USD"); // now 60%
  const milestones = checkGoalMilestones();
  assert.deepEqual(milestones.map((m) => m.thresholdPct), [50]);
});

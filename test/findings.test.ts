import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import {
  createFinding,
  transitionFinding,
  updateBountyStatus,
  InvalidFindingTransitionError,
} from "../src/domain/findings.js";
import type { Program } from "../src/domain/types.js";

let program: Program;

beforeEach(() => {
  freshDb();
  program = createProgram({
    name: "Test Program",
    platform: "self-hosted",
    url: "https://example.com",
    policy: {
      inScope: ["example.com"],
      outOfScope: [],
      allowedMethods: [],
      forbiddenMethods: [],
      automationAllowed: true,
      restrictions: [],
    },
  });
});

test("new finding starts discovered / not_applicable", () => {
  const finding = createFinding({ programId: program.id, title: "Reflected XSS", asset: "example.com" });
  assert.equal(finding.status, "discovered");
  assert.equal(finding.bountyStatus, "not_applicable");
});

test("walks the full lifecycle to accepted then closed", () => {
  const finding = createFinding({ programId: program.id, title: "Reflected XSS", asset: "example.com" });
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  transitionFinding(finding.id, "submitted");
  transitionFinding(finding.id, "triaged");
  const accepted = transitionFinding(finding.id, "accepted");
  assert.equal(accepted.status, "accepted");
  const closed = transitionFinding(finding.id, "closed");
  assert.equal(closed.status, "closed");
});

test("rejects skipping states (discovered -> submitted)", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  assert.throws(() => transitionFinding(finding.id, "submitted"), InvalidFindingTransitionError);
});

test("closed is terminal", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  transitionFinding(finding.id, "invalid");
  const closed = transitionFinding(finding.id, "closed");
  assert.equal(closed.status, "closed");
  assert.throws(() => transitionFinding(finding.id, "candidate"), InvalidFindingTransitionError);
});

test("bounty status is tracked independently of finding lifecycle status", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  const updated = updateBountyStatus(finding.id, "pending");
  assert.equal(updated.bountyStatus, "pending");
  assert.equal(updated.status, "discovered"); // unaffected
});

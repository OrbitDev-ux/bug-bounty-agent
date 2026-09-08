import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createApproval, decideApproval, getApproval, isExpired, expireStaleApprovals } from "../src/domain/approvals.js";

beforeEach(() => {
  freshDb();
});

test("a fresh approval is not expired", () => {
  const approval = createApproval({ requestedAction: "test" });
  assert.equal(isExpired(approval), false);
});

test("an approval created with ttlHours in the past is expired", () => {
  const approval = createApproval({ requestedAction: "test", ttlHours: -1 });
  assert.equal(isExpired(approval), true);
});

test("ttlHours: null means the approval never expires", () => {
  const approval = createApproval({ requestedAction: "test", ttlHours: null });
  assert.equal(approval.expiresAt, null);
  assert.equal(isExpired(approval), false);
});

test("deciding an already-expired approval flips it to 'expired' and refuses the decision", () => {
  const approval = createApproval({ requestedAction: "test", ttlHours: -1 });
  assert.throws(() => decideApproval(approval.id, "approved", "42"), /expired/);
  assert.equal(getApproval(approval.id)?.status, "expired");
});

test("a decided approval cannot be decided again — same-button-twice replay protection", () => {
  const approval = createApproval({ requestedAction: "test" });
  decideApproval(approval.id, "approved", "42");
  assert.throws(() => decideApproval(approval.id, "rejected", "42"), /already/);
  // The original decision is preserved, not overwritten by the replay attempt.
  assert.equal(getApproval(approval.id)?.status, "approved");
});

test("expireStaleApprovals sweeps pending-but-expired approvals in bulk", () => {
  createApproval({ requestedAction: "old one", ttlHours: -1 });
  createApproval({ requestedAction: "old two", ttlHours: -1 });
  createApproval({ requestedAction: "still fresh" });

  const count = expireStaleApprovals();
  assert.equal(count, 2);
});

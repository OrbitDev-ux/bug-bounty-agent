import { test } from "node:test";
import assert from "node:assert/strict";
import { confidenceLabel, formatFindingReviewMessage } from "../src/telegram/approvalMessage.js";

test("confidenceLabel buckets numeric confidence", () => {
  assert.equal(confidenceLabel(0.9), "HIGH");
  assert.equal(confidenceLabel(0.7), "HIGH");
  assert.equal(confidenceLabel(0.5), "MEDIUM");
  assert.equal(confidenceLabel(0.4), "MEDIUM");
  assert.equal(confidenceLabel(0.1), "LOW");
  assert.equal(confidenceLabel(0), "LOW");
});

test("formatFindingReviewMessage matches the section-17 card shape", () => {
  const text = formatFindingReviewMessage({
    findingNumber: 91,
    programName: "Example",
    target: "in-scope",
    category: "Authorization",
    confidence: 0.8,
    confidenceReason: "Observed behavior appears inconsistent with the documented authorization model.",
    scopeVerdict: "ALLOW",
    policyAllowed: true,
    requestedAction: "Continue approved validation",
  });

  assert.match(text, /FINDING REVIEW/);
  assert.match(text, /#91/);
  assert.match(text, /Example/);
  assert.match(text, /Authorization/);
  assert.match(text, /HIGH/);
  assert.match(text, /✅ IN SCOPE/);
  assert.match(text, /✅ ALLOWED/);
  assert.match(text, /Continue approved validation/);
});

test("formatFindingReviewMessage renders DENY/NEEDS_HUMAN_REVIEW scope badges distinctly", () => {
  const deny = formatFindingReviewMessage({
    findingNumber: 1,
    programName: "P",
    target: "x",
    category: "c",
    confidence: 0.1,
    confidenceReason: "r",
    scopeVerdict: "DENY",
    policyAllowed: false,
    requestedAction: "a",
  });
  assert.match(deny, /❌ OUT OF SCOPE/);
  assert.match(deny, /❌ NOT ALLOWED/);

  const review = formatFindingReviewMessage({
    findingNumber: 2,
    programName: "P",
    target: "x",
    category: "c",
    confidence: 0.1,
    confidenceReason: "r",
    scopeVerdict: "NEEDS_HUMAN_REVIEW",
    policyAllowed: false,
    requestedAction: "a",
  });
  assert.match(review, /⚠️ NEEDS REVIEW/);
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { createProgram } from "../src/domain/programs.js";
import { createFinding, transitionFinding, getFinding } from "../src/domain/findings.js";
import { createApproval, decideApproval } from "../src/domain/approvals.js";
import { createReport } from "../src/domain/reports.js";
import { createCandidateFindings, draftReportForApprovedFinding, simulateSubmission } from "../src/agent/orchestrator.js";
import { startResearchSession } from "../src/domain/researchSessions.js";
import type { Program } from "../src/domain/types.js";
import type { ResearchAgentCandidateFinding } from "../src/agent/researcher.js";

let program: Program;
let sessionId: string;

beforeEach(() => {
  freshDb();
  program = createProgram({
    name: "Test Program",
    platform: "self-hosted",
    url: "https://example.com",
    policy: {
      inScope: ["example.com"],
      outOfScope: ["excluded.example.com"],
      allowedMethods: [],
      forbiddenMethods: [],
      automationAllowed: true,
      restrictions: [],
    },
  });
  sessionId = startResearchSession({ programId: program.id, goal: "test goal" }).id;
});

function candidate(overrides: Partial<ResearchAgentCandidateFinding> = {}): ResearchAgentCandidateFinding {
  return {
    title: "Outdated software version disclosed in public docs",
    asset: "example.com",
    category: "Information Disclosure",
    summary: "The public changelog page mentions a specific outdated library version.",
    confidence: 0.5,
    confidenceReason: "Publicly stated version number, not independently confirmed by active testing.",
    severityCandidate: "Low",
    severityReason: "Disclosure alone, no confirmed exploitability.",
    severityConfidence: 0.4,
    ...overrides,
  };
}

test("createCandidateFindings: an out-of-scope candidate is auto-marked invalid, no approval requested", () => {
  const created = createCandidateFindings(program, sessionId, [candidate({ asset: "excluded.example.com" })]);
  assert.equal(created.length, 1);
  const finding = getFinding(created[0]!.id)!;
  assert.equal(finding.status, "invalid");
});

test("createCandidateFindings: an unrelated-domain candidate is auto-marked invalid (not published in scope)", () => {
  const created = createCandidateFindings(program, sessionId, [candidate({ asset: "totally-unrelated.org" })]);
  const finding = getFinding(created[0]!.id)!;
  assert.equal(finding.status, "invalid");
});

test("createCandidateFindings: a likely-duplicate candidate stays 'candidate' and is not auto-advanced", () => {
  const original = createFinding({ programId: program.id, title: "IDOR on /api/orders", asset: "example.com", category: "Authorization" });
  transitionFinding(original.id, "candidate");

  const created = createCandidateFindings(program, sessionId, [
    candidate({
      title: "IDOR on /api/orders allows viewing other orders",
      asset: "example.com",
      category: "Authorization",
      summary: "IDOR on /api/orders",
    }),
  ]);

  const dup = getFinding(created[0]!.id)!;
  assert.equal(dup.status, "candidate");
  assert.equal(dup.duplicateVerdict, "LIKELY_DUPLICATE");
});

test("createCandidateFindings: a novel in-scope candidate stays 'candidate' with intelligence attached and an approval created", () => {
  const created = createCandidateFindings(program, sessionId, [candidate()]);
  const finding = getFinding(created[0]!.id)!;
  assert.equal(finding.status, "candidate");
  assert.equal(finding.duplicateVerdict, "LIKELY_NEW");
  assert.equal(finding.confidence, 0.5);
  assert.equal(finding.category, "Information Disclosure");
});

test("draftReportForApprovedFinding refuses to advance a finding that isn't 'candidate'", async () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  // still 'discovered', never promoted to 'candidate'
  await assert.rejects(() => draftReportForApprovedFinding(finding.id), /not 'candidate'/);
});

test("draftReportForApprovedFinding refuses without a prior approved Telegram approval", async () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  transitionFinding(finding.id, "candidate");
  await assert.rejects(() => draftReportForApprovedFinding(finding.id), /No approved Telegram approval/);
});

test("simulateSubmission refuses a finding that isn't 'report_draft'", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  assert.throws(() => simulateSubmission(finding.id), /not 'report_draft'/);
});

test("simulateSubmission refuses without a separate FINAL APPROVAL (the report-drafting approval alone is not enough)", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  createReport({
    findingId: finding.id,
    title: "t",
    program: program.name,
    asset: finding.asset,
    summary: "s",
    impact: "i",
    stepsToReproduce: "s",
    evidence: "e",
    expectedBehavior: "e",
    observedBehavior: "o",
    suggestedRemediation: "s",
    references: "r",
  });

  // An approval exists but is NOT the "FINAL APPROVAL"-prefixed one.
  const ordinaryApproval = createApproval({ findingId: finding.id, requestedAction: "Continue: mark this candidate validated." });
  decideApproval(ordinaryApproval.id, "approved", "42");

  assert.throws(() => simulateSubmission(finding.id), /No final approval/);
});

test("simulateSubmission succeeds once a FINAL APPROVAL exists — always SIMULATED, creates a pending earning", () => {
  const finding = createFinding({ programId: program.id, title: "X", asset: "example.com" });
  transitionFinding(finding.id, "candidate");
  transitionFinding(finding.id, "validated");
  transitionFinding(finding.id, "report_draft");
  createReport({
    findingId: finding.id,
    title: "t",
    program: program.name,
    asset: finding.asset,
    summary: "s",
    impact: "i",
    stepsToReproduce: "s",
    evidence: "e",
    expectedBehavior: "e",
    observedBehavior: "o",
    suggestedRemediation: "s",
    references: "r",
  });

  const finalApproval = createApproval({ findingId: finding.id, requestedAction: "FINAL APPROVAL: submit the drafted report ..." });
  decideApproval(finalApproval.id, "approved", "42");

  const result = simulateSubmission(finding.id);
  assert.equal(result.finding.status, "submitted");
  assert.equal(result.finding.submissionMode, "SIMULATED");
  assert.ok(result.earningId);
});

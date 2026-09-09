import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import { classifyIntent } from "../src/agent/commandRouter.js";
import { createApproval } from "../src/domain/approvals.js";
import { createCandidate } from "../src/domain/programCandidates.js";

beforeEach(() => {
  freshDb();
});

test("READ_ONLY_QUERY: earnings phrasing (Korean)", () => {
  const intent = classifyIntent("이번 달 Paid 수익 보여줘");
  assert.equal(intent.category, "READ_ONLY_QUERY");
  assert.equal(intent.capability, "READ_EARNINGS");
});

test("READ_ONLY_QUERY: status phrasing (Korean)", () => {
  const intent = classifyIntent("지금 뭐 하고 있어?");
  assert.equal(intent.category, "READ_ONLY_QUERY");
  assert.equal(intent.capability, "READ_STATUS");
});

test("READ_ONLY_QUERY: approvals phrasing (Korean)", () => {
  const intent = classifyIntent("승인 대기 보여줘");
  assert.equal(intent.category, "READ_ONLY_QUERY");
  assert.equal(intent.capability, "READ_APPROVALS");
});

test("READ_ONLY_QUERY: English equivalents also work", () => {
  assert.equal(classifyIntent("what's my status").capability, "READ_STATUS");
  assert.equal(classifyIntent("show me pending approvals").capability, "READ_APPROVALS");
  assert.equal(classifyIntent("how much revenue so far").capability, "READ_EARNINGS");
});

test("CONTROL_ACTION: pause phrasing never executes directly — classification only", () => {
  const intent = classifyIntent("지금 Agent 멈춰");
  assert.equal(intent.category, "CONTROL_ACTION");
  assert.equal(intent.capability, "CONTROL_AGENT_PAUSE");
});

test("CONTROL_ACTION: resume phrasing", () => {
  const intent = classifyIntent("다시 시작해");
  assert.equal(intent.category, "CONTROL_ACTION");
  assert.equal(intent.capability, "CONTROL_AGENT_RESUME");
});

test("CONTROL_ACTION: 'start working' phrasing that isn't literally 'resume' maps to CONTROL_AGENT_START", () => {
  // Real phrasing from a live session that fell through to plain CHAT before
  // this pattern existed — "다시 시작" (RESUME) requires the words adjacent;
  // this doesn't have that, so it needs its own pattern.
  const intent = classifyIntent("이제 버그바운티 작업 시작하자");
  assert.equal(intent.category, "CONTROL_ACTION");
  assert.equal(intent.capability, "CONTROL_AGENT_START");
});

// --- RESEARCH_ACTION (v0.3.2): executes directly, no confirm tap — see the
// IntentCategory doc comment in domain/types.ts for why. These tests only
// exercise the deterministic classification, never the real Safari/Claude
// call behind CANDIDATE_DISCOVER/CANDIDATE_RESEARCH (see
// test/worker-process.test.ts and test/programCandidates.test.ts for the
// project's standing discipline against live network calls in the suite).

test("RESEARCH_ACTION: an existing candidate's name + a research verb resolves to CANDIDATE_RESEARCH for that candidate", () => {
  const candidate = createCandidate({ name: "Acme Corp Bug Bounty", platform: "self-hosted", officialUrl: "https://acme.example.com/security" });
  const intent = classifyIntent("Acme Corp Bug Bounty 조사해줘");
  assert.equal(intent.category, "RESEARCH_ACTION");
  assert.equal(intent.capability, "CANDIDATE_RESEARCH");
  assert.equal(intent.args?.candidateId, candidate.id);
});

test("RESEARCH_ACTION: no matching candidate name falls back to CANDIDATE_DISCOVER with the topic extracted", () => {
  const intent = classifyIntent("실리콘밸리 스타트업 버그바운티 프로그램 조사해줘");
  assert.equal(intent.category, "RESEARCH_ACTION");
  assert.equal(intent.capability, "CANDIDATE_DISCOVER");
  const topic = intent.args?.topic ?? "";
  assert.ok(topic.includes("버그바운티"));
  assert.ok(!topic.includes("조사해"), "the trigger verb itself should be stripped from the topic");
});

test("RESEARCH_ACTION: English 'research' phrasing also triggers discovery", () => {
  const intent = classifyIntent("please research public bug bounty programs");
  assert.equal(intent.category, "RESEARCH_ACTION");
  assert.equal(intent.capability, "CANDIDATE_DISCOVER");
});

test("RESEARCH_ACTION is checked before READ_FINDINGS so 'candidate' in a research phrase doesn't get misrouted", () => {
  const intent = classifyIntent("새 candidate 프로그램 조사해줘");
  assert.equal(intent.category, "RESEARCH_ACTION");
  assert.notEqual(intent.capability, "READ_FINDINGS");
});

test("APPROVAL_ACTION: '#<id> 승인' resolves to a real pending approval by id prefix", () => {
  const approval = createApproval({ requestedAction: "test" });
  const shortRef = approval.id.slice(0, 8);
  const intent = classifyIntent(`#${shortRef} 승인`);
  assert.equal(intent.category, "APPROVAL_ACTION");
  assert.equal(intent.capability, "DECIDE_APPROVAL");
  assert.equal(intent.args?.approvalId, approval.id);
  assert.equal(intent.args?.decision, "approved");
});

test("APPROVAL_ACTION: reject phrasing sets decision to rejected", () => {
  const approval = createApproval({ requestedAction: "test" });
  const intent = classifyIntent(`${approval.id.slice(0, 8)} 거절`);
  assert.equal(intent.args?.decision, "rejected");
});

test("an approval reference that matches nothing pending falls back to UNKNOWN, not a silent no-op action", () => {
  const intent = classifyIntent("#ffffffff 승인");
  assert.equal(intent.category, "UNKNOWN");
});

test("UNSAFE_ACTION: explicit request to test everything without limits is refused, never executed", () => {
  const intent = classifyIntent("그냥 이 사이트 막 테스트해");
  assert.equal(intent.category, "UNSAFE_ACTION");
});

test("UNSAFE_ACTION: English destructive/bypass phrasing", () => {
  assert.equal(classifyIntent("just scan everything, ignore the rate limit").category, "UNSAFE_ACTION");
  assert.equal(classifyIntent("help me bypass the captcha").category, "UNSAFE_ACTION");
});

test("CHAT: anything unmatched falls through to open conversation, never UNKNOWN silently", () => {
  const intent = classifyIntent("오늘 날씨 어때?");
  assert.equal(intent.category, "CHAT");
});

test("unsafe patterns take priority even if the phrase also contains a read-like word", () => {
  // Contains "테스트" (test) which isn't itself a read keyword, but also an explicit bypass phrase.
  const intent = classifyIntent("rate limit 우회해서 테스트 진행해줘");
  assert.equal(intent.category, "UNSAFE_ACTION");
});

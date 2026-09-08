import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./testDb.js";
import {
  startResearchSession,
  addQuery,
  addPageVisited,
  completeResearchSession,
  getResearchSession,
  listRunningResearchSessions,
} from "../src/domain/researchSessions.js";
import { recordSourceEvidence, listEvidenceForSession } from "../src/domain/sourceEvidence.js";

beforeEach(() => {
  freshDb();
});

test("starts a session in 'running' with empty collections", () => {
  const session = startResearchSession({ goal: "find candidate fintech bug bounty programs" });
  assert.equal(session.status, "running");
  assert.deepEqual(session.queries, []);
  assert.deepEqual(session.pagesVisited, []);
});

test("queries and pages accumulate incrementally (resumable session)", () => {
  const session = startResearchSession({ goal: "research example.com policy" });
  addQuery(session.id, "example.com bug bounty policy");
  addQuery(session.id, "example.com responsible disclosure");
  addPageVisited(session.id, { url: "https://example.com/security", title: "Security", capturedAt: new Date().toISOString() });

  const reloaded = getResearchSession(session.id)!;
  assert.equal(reloaded.queries.length, 2);
  assert.equal(reloaded.pagesVisited.length, 1);
  assert.equal(reloaded.pagesVisited[0]?.url, "https://example.com/security");
});

test("a running session appears in listRunningResearchSessions and disappears once completed", () => {
  const session = startResearchSession({ goal: "goal" });
  assert.equal(listRunningResearchSessions().some((s) => s.id === session.id), true);

  completeResearchSession(session.id, { status: "completed", summary: "done", confidence: 0.7 });

  assert.equal(listRunningResearchSessions().some((s) => s.id === session.id), false);
  const reloaded = getResearchSession(session.id)!;
  assert.equal(reloaded.status, "completed");
  assert.equal(reloaded.summary, "done");
  assert.equal(reloaded.confidence, 0.7);
});

test("source evidence links to a research session and is listable", () => {
  const session = startResearchSession({ goal: "goal" });
  recordSourceEvidence({
    researchSessionId: session.id,
    sourceUrl: "https://example.com/security",
    sourceType: "OFFICIAL_POLICY",
    title: "Example Security Policy",
    relevantExcerpt: "In scope: *.example.com",
  });
  recordSourceEvidence({
    researchSessionId: session.id,
    sourceUrl: "https://blog.example.org/mentions-example-bounty",
    sourceType: "PUBLIC_REFERENCE",
    title: "A blog post",
  });

  const evidence = listEvidenceForSession(session.id);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0]?.sourceType, "OFFICIAL_POLICY");
});

# Research Workflow (v0.2)

## The Research Agent

`runResearchSession()` (`src/agent/researcher.ts`) is the Research Agent from
project brief v0.2 section 4. It takes:

- `goal` — what to research
- `programContext` (optional) — the program's own name/URL/scope/policy, so
  the agent stays grounded in what's actually published rather than guessing
- `previousResearchSummary` (optional) — continuity across sessions

and returns a single structured object (enforced via `claude --json-schema`,
not free-text parsing):

```
researchSummary, scopeObservations, policyObservations, officialSourceFound,
queriesRun, pagesVisited, sourcesUsed[], candidateFindings[],
nextRecommendedAction, confidence
```

Every prompt is prefixed with two fixed notices (see docs/security.md):
an untrusted-web-content notice (section 23) and an official-source-priority
notice (section 7).

## The pipeline (`src/agent/orchestrator.ts`)

```
runResearchTask(programId, goal)
  │
  ├─ createTask(type: 'research', programId, target: goal)      [DB]
  ├─ transitionTask -> running (with a timeout deadline)
  ├─ startResearchSession(...)                                   [DB, before the paid call —
  │                                                                a crash here leaves 'running',
  │                                                                not lost work]
  ├─ runResearchSession(...)                                     [Claude + Safari MCP]
  │     │
  │     ├─ on failure: completeResearchSession(status:'failed'), transitionTask -> failed
  │     │
  │     └─ on success:
  │           ├─ persist queries / pages visited / source evidence   [DB]
  │           ├─ createCandidateFindings(program, sessionId, candidates)
  │           │     for each candidate:
  │           │       ├─ createFinding(...) -> transitionFinding('candidate')
  │           │       ├─ evaluateTargetScope(program, candidate.asset)
  │           │       │     DENY  -> transitionFinding('invalid'); stop here
  │           │       ├─ detectDuplicates(candidate, existingFindings)   [deterministic, no LLM]
  │           │       │     LIKELY_DUPLICATE -> leave 'candidate'; stop here (never auto-advanced)
  │           │       ├─ setCandidateIntelligence(confidence, duplicateVerdict, severity...)
  │           │       └─ requestFindingApproval(...)   [Telegram Finding Review card]
  │           │
  │           └─ completeResearchSession(status:'completed', summary, candidateFindingIds)
  │
  └─ transitionTask -> completed
```

## Why duplicate detection is deterministic, not an LLM call

`detectDuplicates()` (`src/domain/duplicateDetection.ts`) compares a
candidate's asset/category/title/summary against a program's existing
findings using a Jaccard-similarity-plus-asset/category-boost heuristic —
no Claude call. The "never auto-advance a likely duplicate" safety rule
(section 14) shouldn't depend on a model call succeeding, being
well-calibrated, or being reproducible run-to-run. See its 6 unit tests for
the exact thresholds and behavior.

## Verified live

- Full `runResearchSession()` call against a local test page containing a
  real prompt-injection payload: the agent did not comply, reported the
  attempt factually, and correctly flagged the source as non-official — see
  docs/agent.md for the transcript.
- Full `runWorkerLoop()` run (Scheduler -> Planner -> `executeDiscoveryTask`)
  against a real, live public-web research goal — see docs/scheduler.md.
- `createCandidateFindings()`'s scope/duplicate branching (DENY -> invalid,
  LIKELY_DUPLICATE -> not advanced, novel -> approval requested) is
  unit-tested directly (`test/orchestrator-pipeline.test.ts`) without
  needing a live Research Agent call for every case.

## Known limitation

In practice, routine "read a public policy page" research rarely produces
genuine `candidateFindings` — that's expected and correct: v0.2 does not
perform active testing, so candidates can only come from what's observable
in public documentation itself (see the schema description in
`researcher.ts`). `scripts/synthetic-finding-e2e.ts` exercises everything
*downstream* of "a candidate exists" using a fabricated finding, since
relying on the live agent to spontaneously produce one would make that demo
non-deterministic and needlessly costly.

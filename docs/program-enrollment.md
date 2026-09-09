# Program Candidate Discovery & Enrollment Preparation (v0.3.2)

Before this feature existed, "add a program" (`bba program add`) assumed you
already knew which program you wanted and just needed its scope extracted.
This feature covers the step before that: finding a real, public bug bounty
program worth joining, comparing it against alternatives, and preparing to
enroll — **without ever touching a live target** until enrollment is
actually finished.

## The core guarantee: NOT ENROLLED -> LIVE_TESTING = BLOCKED

`program_candidates` is a table completely separate from `programs`. A
candidate row can never be used to create a `Task`, call `evaluateScope()`,
or otherwise touch a real target — nothing in the codebase wires it to any
of that. The only bridge between the two is
`activateForResearch()` (`src/domain/programCandidates.ts`), which creates a
real `programs` row and is reachable only via
`bba program activate-candidate <id>`, which itself refuses unless the
candidate is already `authorized`.

This means "live testing is blocked before enrollment" is true **by
construction**, not by a check someone could forget to add.

## The state machine

```
discovered -> researched -> candidate -> enrollment_pending -> authorized -> ready_for_research
```

- `discovered -> researched -> candidate`: automatic, on a successful
  `recordResearch()` call — this is desk research (reading a public page),
  not a decision, so there's no human gate here.
- `candidate -> enrollment_pending`: **the only human-gated step before
  enrollment** (`selectCandidate()`) — a human must tap `[✅ Select]` in
  Telegram or run `bba program select-candidate <id>`. Generates the
  enrollment checklist at the same moment.
- `enrollment_pending -> authorized`: `confirmAuthorization()`, triggered by
  the human saying "I have enrolled" (Telegram `[✅ I have enrolled]` or
  `bba program authorize-candidate <id>`). **Purely self-reported** — this
  function never checks the actual platform. The UI says so explicitly
  everywhere this state is shown.
- `authorized -> ready_for_research`: `activateForResearch()`
  (`bba program activate-candidate <id>` only — no Telegram button). Before
  creating the real `programs` row, this re-runs `extractProgramPolicy()`
  fresh — it never reuses the candidate's earlier free-text `scopeSummary`,
  which was never a structured `ProgramPolicy` and may be stale.

Illegal transitions throw `InvalidProgramCandidateTransitionError`
(mirrors `InvalidTaskTransitionError` in `src/domain/tasks.ts`).

Cancellation (`cancelCandidate()`) is orthogonal to the state machine — a
`cancelled_at` timestamp, like `Goal.archivedAt` — and is refused once a
candidate has a `linked_program_id` (cancelling here would do nothing to an
already-live program; the real program has to be managed directly).

## Research pipeline

```
bba program discover "<topic>"
  │
  ├─ discoverProgramCandidateLeads(topic)     [Safari search, read-only]
  │     returns structured {name, platform, officialUrl}[] — never free text
  │
  └─ createCandidate(...) per lead             [dedup by canonicalizeUrl()]

bba program research-candidate <id>
  │
  └─ researchProgramCandidate({name, platform, officialUrl})   [Safari, read-only]
        reads the official page, rates scope/policy/reward clarity
        HIGH/MEDIUM/LOW/UNKNOWN, reports automationPolicy and every
        eligibility check as allowed/forbidden/needs_review/unknown or
        yes/no/unknown — NEVER guessed. Silence in the published policy on
        automation reports 'unknown', never defaults to 'allowed'.
      │
      └─ recordResearch(...) -> auto-advances to 'candidate'
```

Both calls go through `runClaude()` with the same read-only Safari MCP tool
set and the same untrusted-web-content / official-source-priority notices
as the existing Research Agent (see docs/research-workflow.md) — nothing
new was invented for source trust here, it reuses the existing discipline.

## Recommendation scoring

`computeRecommendationScore()` (`src/domain/programCandidates.ts`) is a
deterministic, explainable heuristic over eligibility, scope clarity, policy
clarity, automation compatibility, reward transparency, and public/private
accessibility — 0-100, decision-support only. It is never a claim about real
success odds or expected revenue, and that disclaimer is carried into every
Telegram/CLI rendering of the score. `compareCandidates()` /
`bba program compare` sort by this score, never by reward alone.

## Telegram

- `/discover "<topic>"` — triggers real discovery from chat.
- `/candidates` — every non-cancelled candidate with its stage.
- `/candidate <id>` — full detail (`[📄 Details] [📊 Compare] [✅ Select] [❌ Cancel]`).
- After `[✅ Select]`: the enrollment checklist, with per-item toggle buttons
  and `[✅ I have enrolled]`.
- **No Telegram button reaches `activateForResearch()`.** The final,
  live-target-unlocking step is deliberately CLI-only — it's the single
  highest-consequence action in this feature (it can flip a real program to
  `status: active`, which lets `evaluateScope()` return `ALLOW`), so it gets
  one more deliberate step of friction than a chat tap.

`src/services/dashboard.ts` exposes `getProgramCandidates()`,
`getProgramComparison()`, `getEnrollmentStatus()`, `getSelectedProgram()` —
the same functions `src/telegram/views.ts` calls, so a future web-dashboard
page for this would read identical data, not a second implementation.

## What's verified vs. not

- **Verified (real, no network):** the full state machine including illegal
  transitions, URL-dedup across protocol/`www.`/trailing-slash/query
  variations, checklist generation and per-item toggling, self-reported
  authorization never claiming independent verification, recommendation
  scoring (including that a high-reward-but-opaque candidate never
  outranks a clear/automation-friendly one), the dashboard service layer,
  every Telegram view formatter, and — most importantly — that
  `canStartLiveResearch()` stays `false` through every stage up to and
  including `authorized`, and only becomes `true` after `activateForResearch()`
  actually creates the linked live program. See `test/programCandidates.test.ts`,
  the candidate additions to `test/dashboard-services.test.ts` and
  `test/telegram-views.test.ts`.
- **Not yet verified in this session:** a live `bba program discover`/
  `research-candidate` run against real public program pages (needs a live
  Safari session), and a live Telegram round-trip tapping the actual
  `[✅ Select]` / `[✅ I have enrolled]` buttons.

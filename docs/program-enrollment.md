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

## Chat-triggered auto-research (v0.3.2)

Free-text chat (`/chat` mode) recognizes research phrasing directly — e.g.
"Shopify 버그바운티 조사해줘" or "research public bug bounty programs" — and
executes `CANDIDATE_DISCOVER`/`CANDIDATE_RESEARCH` **immediately, with no
confirm tap**, unlike `CONTROL_AGENT_PAUSE`/`RESUME` (`src/agent/
commandRouter.ts` `classifyResearchIntent()`, new `IntentCategory:
"RESEARCH_ACTION"`). This is a deliberate exception to the project's usual
confirm-before-executing rule for chat-triggered actions, justified by the
same structural guarantee as everywhere else in this feature: discovery/
research only ever reads public web pages and writes to
`program_candidates`, which has no code path to a live target — so there is
nothing here for a confirm tap to actually be protecting against. If the
message mentions an existing candidate's name, it deep-researches that one;
otherwise the phrase (minus the trigger verb) becomes a fresh discovery
search topic. Verified live: "Shopify 버그바운티 프로그램 조사해줘" through
`handleChatText()` found 2 real candidates with no confirmation step.

## Telegram

Every step is reachable from Telegram — nothing in this pipeline requires
the CLI. `/candidate <id>` (and the `candidate:details` callback) render a
**stage-aware** action keyboard (`candidateActionKeyboard()` in
`src/telegram/views.ts`) that only ever offers the action actually legal at
that candidate's current stage:

| Stage | Buttons offered |
|---|---|
| `discovered` / `researched` | `[🔬 Research] [❌ Cancel]` |
| `candidate` | `[📄 Details] [📊 Compare]` / `[✅ Select] [❌ Cancel]` |
| `enrollment_pending` | `[📋 View Checklist] [❌ Cancel]` → per-item toggles + `[✅ I have enrolled]` |
| `authorized` | `[🚀 Activate for Live Research] [❌ Cancel]` |
| `ready_for_research` | `[✅ Live: <program id>]` (informational only) |

Commands: `/discover "<topic>"`, `/candidates`, `/candidate <id>`,
`/research <id>` (deep-dive), `/compare`, `/recommend`, `/activate <id>`.
`/liveresearch <program-id-or-name> <goal>` runs a real Research Agent
session against an already-live, enrolled program (`runResearchTask()` from
`src/agent/orchestrator.ts`) — the step after a candidate is fully
activated.

**Activation still requires an explicit Confirm tap.** Tapping
`[🚀 Activate for Live Research]` (or `/activate <id>`) shows a
`⚠️ ... Confirm?` prompt with `[✅ Confirm Activate] [❌ Cancel]` before
`activateForResearch()` ever runs — it's the single highest-consequence
action in this feature (it can flip a real program to `status: active`,
which lets `evaluateScope()` return `ALLOW`), so it gets the same
confirm-before-executing treatment as `CONTROL_AGENT_PAUSE`/`RESUME`, never
a bare one-tap button.

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
- **Verified live (real Safari + Claude calls, real public pages):**
  `bba program discover` found real candidates (Microsoft Bug Bounty
  Program, GitHub Bug Bounty via HackerOne) from a real search;
  `bba program research-candidate` deep-researched both — GitHub came back
  scope/policy HIGH clarity, automation `allowed`; Microsoft came back
  scope/policy HIGH clarity, automation `needs_review` (its page doesn't
  explicitly address automated tooling, so it correctly did NOT default to
  `allowed`).
- **Not yet verified in this session:** a live Telegram round-trip actually
  tapping the buttons (`[🔬 Research]`, `[✅ Select]`, `[✅ I have enrolled]`,
  `[🚀 Activate for Live Research]` + its confirm prompt) — the command/
  callback wiring is code-complete and unit-tested (see
  `candidateActionKeyboard`'s stage test in `test/telegram-views.test.ts`)
  but a human hasn't tapped through it in a real chat yet. `/liveresearch`
  is similarly code-complete but unexercised live — no program has reached
  `ready_for_research` yet to test it against.

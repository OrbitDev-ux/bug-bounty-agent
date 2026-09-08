# Policy Engine (v0.2)

## Three-state Scope Intelligence

`evaluateScope()` (`src/domain/scope.ts`) replaces v0.1's boolean-only scope
check with the three-state verdict from project brief section 10:

| Verdict | When |
|---|---|
| `ALLOW` | Program active, automation explicitly allowed, target matches a published in-scope pattern and not an out-of-scope one, and the policy was verified recently enough to trust (or freshness isn't tracked for this record at all — see below). |
| `DENY` | Program not active, automation not allowed, target matches an out-of-scope pattern, or target matches no in-scope pattern. All explicit, not ambiguous. |
| `NEEDS_HUMAN_REVIEW` | The program has no published in-scope entries at all (scope is unclear, not confirmed absent), or an otherwise-matching policy hasn't been re-verified within `STALE_POLICY_DAYS` (90). |

`checkScope()` is kept as an exact-behavior boolean wrapper
(`allowed = verdict === "ALLOW"`) for v0.1 callers/tests — every original
v0.1 scope test still passes unmodified against it.

**Uncertainty never resolves to ALLOW.** Both DENY and NEEDS_HUMAN_REVIEW
collapse to `allowed: false` in the boolean view; code that needs to tell a
hard block apart from "ask a human" calls `evaluateScope()`/
`evaluateTargetScope()` directly.

## Policy freshness

`Program.policyLastVerifiedAt` / `policyHash` (new columns, added via
`src/db/migrations.ts` so existing v0.1 databases upgrade in place — verified
live against the actual demo database from the v0.1 session, zero data loss)
track when a policy was last actually read and a hash to detect drift.
`createProgram({ policyVerifiedNow: true })` stamps the current time;
`reverifyPolicy(programId, newPolicy)` re-reads a policy, reports whether it
actually changed (`drifted`) via hash comparison, and updates the timestamp.

A record with `policyLastVerifiedAt` unset is treated as "freshness not
tracked" rather than "definitely stale" — this only matters for objects that
never opted into the freshness field (plain v0.1-era fixtures); every
program created going forward through the real onboarding flow gets a real
timestamp and is subject to the 90-day check.

## Candidate Finding intelligence

Added to `findings` (nullable, advisory-only, never auto-driving state):

- `category`, `confidence` (0-1), `confidenceReason`
- `duplicateVerdict` (`LIKELY_NEW` / `POSSIBLE_DUPLICATE` / `LIKELY_DUPLICATE`), `duplicateOfFindingId`
- `severityCandidate`, `severityReason`, `severityConfidence` — a *suggestion*, never a final severity; a program's own published severity rubric always wins if one exists
- `researchSessionId` — links back to the session that produced it
- `submissionMode` (`SIMULATED` / `LIVE`) — v0.2 only ever writes `SIMULATED`

See docs/research-workflow.md for how these get set, and docs/findings.md
for the full lifecycle these fields sit alongside.

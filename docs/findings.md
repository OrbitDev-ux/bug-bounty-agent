# Findings, Reports, and Submission (v0.2)

## Lifecycle recap (unchanged from v0.1)

```
discovered -> candidate -> validated -> report_draft -> submitted -> triaged
  -> {accepted, duplicate, invalid, informative} -> closed
```

Enforced by `FINDING_TRANSITIONS` in `src/domain/findings.ts` — unchanged
from v0.1, all original tests still pass.

## What v0.2 adds around it

1. **Candidate creation** (`createCandidateFindings()`, orchestrator.ts):
   every candidate the Research Agent proposes gets scope-checked and
   duplicate-checked *before* anything else happens to it. Out-of-scope ->
   `invalid` immediately. Likely-duplicate -> stays `candidate`, flagged, not
   advanced. Everything else -> a Telegram Finding Review approval request.

2. **`validated` is reached on human approval, not automated testing.**
   v0.2 has no Validator role (see docs/security.md) — when a human approves
   a candidate via the Finding Review card, `draftReportForApprovedFinding()`
   transitions `candidate -> validated` on the strength of that approval,
   logging explicitly that no automated validation occurred. This is a
   deliberate interpretation given the project brief's "Safe Next Step" step
   has no automated executor in v0.2; a future Validator role would sit
   exactly here.

3. **Report drafting requires a prior approval, re-checked server-side.**
   `draftReportForApprovedFinding(findingId)` looks up
   `listApprovals("approved").find(a => a.findingId === findingId)` itself —
   it never trusts a caller's claim that something was approved.

4. **A SEPARATE final approval gates submission.** The report-drafting
   approval and the submission approval are two different `Approval` rows;
   the final one's `requestedAction` is prefixed `"FINAL APPROVAL"` and
   `simulateSubmission()` specifically looks for that prefix, not just any
   approved row on the finding. See `test/orchestrator-pipeline.test.ts` for
   the test proving an ordinary (non-final) approval alone is rejected.

5. **Submission is always `SIMULATED`.** `simulateSubmission()`
   (project brief section 28) sets `Finding.submissionMode = 'SIMULATED'`
   unconditionally — there is no platform API integration in v0.2, so there
   is no other value it could honestly write. It creates an `Earning` row
   with `bountyStatus: 'pending'`, which is where the existing v0.1 bounty
   lifecycle (`pending -> awarded -> paid`, `Accepted != Paid`, only `paid`
   counts toward realized revenue) picks up unchanged.

## Verified live

`scripts/synthetic-finding-e2e.ts` runs a fabricated finding through this
entire sequence for real — candidate -> approval -> validated -> a real
Claude-drafted report -> a separate final approval -> `SIMULATED` submission
-> `pending -> awarded -> paid` -> `earnings.summarizeEarnings()` correctly
reflecting the (fabricated, clearly-labeled) amount. See its output in
docs/agent.md.

# Persistent Scheduler (v0.2)

## Pieces

| File | Role |
|---|---|
| `src/domain/schedulerState.ts` | Singleton `scheduler_state` row: `stopped`/`running`/`paused`, per-run counters, run limits. |
| `src/agent/planner.ts` | `selectNextTask()` (Planner) and `runSafetyHousekeeping()` (P0 recovery/expiry pass). |
| `src/agent/scheduler.ts` | `runWorkerLoop()`, `runOnce()`, `recoverStaleTasksNow()`, `pauseAgent()`/`resumeAgent()`/`stopAgent()`. |

## The Planner

`selectNextTask()` is deliberately simple for v0.2's scale: `Task.priority`
(`high`/`normal`/`low`, already part of the v0.1 schema) plus FIFO within a
priority band. This is an explicit, testable policy, not a scoring model —
matching the brief's permission to scale the Planner to the project's actual
size (section 25). Task types the scheduler has no executor for
(`scope_check`/`validate`/`submit` as standalone queued items — those flows
run inline via the orchestrator's approval-driven functions instead) are
flagged `risk: "needs_review"` rather than assumed safe.

## The worker loop

```
runWorkerLoop(limits)
  startScheduler(limits)               # resets per-run counters, applies limits
  loop:
    if scheduler_state.status != 'running': stop   # pause/stop from another
                                                     # process takes effect here
    if runLimitReached(state): stop
    runSafetyHousekeeping(recover)      # P0: stale-task recovery + approval-expiry sweep, every tick
    task = selectNextTask()
    if !task: stop ("queue empty")
    dispatchTask(task)                  # research -> executeResearchTask/executeDiscoveryTask;
                                         # anything else -> blocked (not spun on forever)
    incrementTasksRun()
  stopScheduler() (unless it ended paused/externally-stopped)
```

Re-checking `scheduler_state` from the database on every iteration (not just
at loop entry) means a separate `bba agent pause` invocation while the loop
is running takes effect before the next task starts, not after the whole
run finishes.

## Run limits (section 33 — never unbounded)

Defaults applied whenever a limit isn't explicitly overridden:

```
maxTasksPerRun:  20
maxRuntimeMs:    2 hours
maxBrowserOps:   200
maxRetries:      3
```

`bba agent start --daemon` raises the defaults (100 tasks / 8 hours) for
longer-lived operation — but still bounded, per the brief's explicit "don't
run truly unlimited even in daemon mode."

## Crash recovery (section 32)

A task's `timeout_at` is set when it enters `running`
(`RESEARCH_TASK_TIMEOUT_MS` = 10 minutes for research tasks).
`listStaleRunningTasks()` finds anything still `running` past that deadline;
`recoverStaleTask()` **always** moves it to `failed` first (never
auto-`completed` — a lost process is never assumed to have succeeded), with
an explicit "possible crash" reason and an incremented `retryCount`.
`requeueRecoveredTask(id, maxRetries)` then either requeues it (`queued`,
under the limit) or leaves it `failed` for human review (limit exhausted).
This two-step "always fail first, then decide" sequence is exactly the
`RUNNING -> stale timeout -> RECOVER -> QUEUED / NEEDS_REVIEW` flow from the
brief.

## Verified live

```
$ create a queued program-less research task
$ runWorkerLoop({ maxTasksPerRun: 1, maxRuntimeMs: 120000 })

task_started -> real Claude+Safari research call ($0.12) -> task_completed
scheduler_stopped: {"tasksExecuted":1,"stoppedReason":"max_tasks_per_run (1) reached"}
final scheduler_state: {"status":"stopped","tasksRunThisRun":1,"browserOpsThisRun":1,...}
```

The Planner picked the task up, the worker executed it for real, and the
loop stopped itself exactly at the configured limit — not before, not after.
12 unit tests cover the network-free parts (planner ordering, safety
housekeeping, unsupported-type blocking, pause/resume/stop) without
depending on this live path.

## v0.3.2: Worker process vs. scheduler flag (fixes a real incident)

`scheduler_state.status` (stopped/running/paused) and an actual worker
*process* consuming the queue are two different things. `runWorkerLoop()`
checks the flag between tasks — but only if a loop is actually alive to
check it. With no launchd daemon installed and no `bba agent start` running
in a terminal, pressing **/resume** in Telegram only flipped the DB flag;
no task ever actually ran, because nothing was there to notice the flag
changed. This was caught live: a user pressed resume/asked the chat to
"start" repeatedly and nothing happened, because `resumeScheduler()` also
only succeeds from `'paused'` — the scheduler's actual state most of the
time is `'stopped'` (its default, until something has run at least once),
so the call was silently throwing on top of doing nothing.

Fixed in `src/agent/workerProcess.ts` (`startBoundedWorkerRun()` /
`getWorkerProcessStatus()`, PID-tracked, not launchd-based) plus
`executeCapability("CONTROL_AGENT_RESUME" | "CONTROL_AGENT_START")` in
`src/agent/capabilities.ts`: resuming now starts a real, bounded
`bba agent start` process (default limits — same as running it by hand)
whenever none is already alive, and a `resumeScheduler()` failure (e.g.
"not paused") no longer blocks that — the spawned process's own
`startScheduler()` call sets the flag correctly regardless. `/status` and
`bba agent status` now show a `Worker process: RUNNING (pid N)` /
`NOT RUNNING` line, so the flag and reality can never silently diverge in
what's displayed.

Verified live: with the scheduler in its real default `stopped` state and
no process running, invoking the exact capability Telegram's `/resume` uses
spawned a real worker process (confirmed by PID), which ran to completion
against the actual (empty) queue and exited cleanly.

## Not implemented in v0.2

- No OS-level daemonization (`launchd`/systemd unit, background detach) —
  `agent start [--daemon]` is a bounded foreground run in the current
  terminal/process. A real always-on deployment would wrap this in a process
  supervisor; that's explicitly deferred (see the Next Recommended Milestone
  in the final delivery report).

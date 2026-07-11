# Daemon event vocabulary + Monitor filter

On-demand reference for `/orchestrate`. Read this when you need the full event
taxonomy or the exact Monitor regex; the injected `SKILL.md` only points here.

## Daemon event vocabulary (the only thing your Monitor filter should match)

The .js daemon emits exactly these event kinds. Anything else is bookkeeping noise — do not subscribe to it. Each kind below is dedup'd as noted; if you see it, it carries new information.

| Event | Shape | Emitted by | Dedup |
|---|---|---|---|
| `question-pending` | `ACTION {json} kind=question-pending` (there is NO separate `QUESTION-DETECTED` token — questions arrive as this ACTION row) | `detectors/question.js` | Fires once when a prompt sits ≥`Q_WAIT_MIN` minutes; re-alerts per `Q_RE_NUDGE_MIN` |
| `ACTION … kind=…` | JSONL row in `/tmp/maestro-alerts.jsonl`, summary line in tmux `maestro-alerts` | `actions.alert` | One per kind per ticket per state, then mutes until state flips |
| `pr-ready` | `ACTION … kind=pr-ready prNumber=N sha=…` | `detectors/pr-status.js` | Emit on first sight + state transition; re-emit same state at most every `PR_STATUS_RE_EMIT_MIN` (30m) |
| `pr-broken` | `ACTION … kind=pr-broken failingChecks=[…]` | `detectors/pr-status.js` | Same dedup as `pr-ready` |
| `pr-pending` | log-only, `<S> pr-pending PR #N sha=… checks running` | `detectors/pr-status.js` | Per-tick log; informational, **not** an alert |
| `wedged` | `ACTION … kind=wedged restartsInWindow=N` + `<S> WEDGED — N auto-restarts in Mm` | `actions.autoRestart` (restart-loop guard) | Once per session per `WEDGED_QUIET_MIN` (60m) suppression window |
| `AUTO-RESTART after Ns silence` | log-only | `actions.autoRestart` | One per restart, not throttled |
| `AUTO-RESTART skipped: non-work helper` | log-only | `runSilenceDetector` | Throttled by `SILENCE_LIMIT_SEC` |
| `NUDGE soft` / `NUDGE interrupt` | log-only + tmux send to agent pane | `actions.soft` / `actions.interrupt` | Per phase `reNudgeMin` |
| `nudges-exhausted` | `ACTION … kind=nudges-exhausted` | `handlePhaseStall` | One alert per phase, until phase advances |
| `pr-comments-stuck` | `ACTION … kind=pr-comments-stuck` | `handlePrComments` | One alert until comment count or HEAD changes |
| `commit-stall NNNm` | log-only below `COMMIT_STALL_WAKE_MIN`; `ACTION … kind=commit-stall threshold=TTT` at/above it | `runCommitStallDetector` | **Threshold-only**: emits at `[30, 60, 120, 240, 480]` minutes, at most 5 lines per stall. Crossings ≥`COMMIT_STALL_WAKE_MIN` (240m) are waking alerts — an 8h no-commit stall used to surface only in the logfile (GH-698) |
| `stop-condition-met` | `ACTION … kind=stop-condition-met oracle=…` + `<S> STOP-CONDITION-MET — tmux killed, slot freed` | `stop-condition.maybeStopOnOracle` → `actions.freeStopConditionSlot` | Once per ticket lifecycle (`stop-condition` marker); ticket marked `done` |
| `dead-end-probe` | `ACTION … kind=dead-end-probe attempts=N` | `dead-end-rotation` | First dead-end of a lifecycle: a diagnostic prompt is sent to the AGENT (no kill); wait `DEAD_END_PROBE_GRACE_MIN`, read the pane reply, intervene or let the next re-emit rotate |
| `dead-end` | `ACTION … kind=dead-end attempts=N exhausted=bool` | `dead-end-rotation` → `killAndBootstrapNext` | Kill+rotate strike: manifest `pending` (re-eligible) below `DEAD_END_MAX_ATTEMPTS`, `blocked` at max. Attempts persist across re-bootstraps; reset only on phase advance. The just-killed ticket is excluded from the next bootstrap pick |
| `kill-during-ci` | `ACTION … kind=kill-during-ci phase=…` | `ci-gate-rotation` → `actions.freeCiPhaseSlot` | /work agent parked at `ci`/`complete` is killed + slot rotated (PR #603 decision): `complete`→`done`, `ci`→`awaiting-merge`. /work-only (follow-up/generic pools rotate via oracles). Gate: `AUTO_FREE_CI_SLOT=0` disables |
| `comment-loop` | `ACTION … kind=comment-loop cycles=N` | `pr-comments-handler` | ≥`COMMENT_LOOP_CYCLES` (3) fix→push→re-comment cycles: nudging is SUPPRESSED (it feeds the loop); operator judges the threads. Re-emits per `COMMENT_LOOP_RE_EMIT_MIN` (60m) |
| `auth-broken` | `ACTION … kind=auth-broken line=…` | `runAuthBrokenDetector` | Credential failure visible in the pane (403 / Bad credentials / Could not resolve to a Repository) — gh account flapping breaks whole fleets silently. Re-emits per `AUTH_BROKEN_RE_EMIT_MIN` (30m) |
| `spinner-hang` | `ACTION … kind=spinner-hang elapsedMin=N line=…` | `runSpinnerDetector` | Progress-gated: never fires while the worktree changed <`PROGRESS_FRESH_MIN`; re-emits per `SPINNER_RE_INTERRUPT_MIN`. Default is ALERT-ONLY (`SPINNER_AUTO_INTERRUPT=1` restores the old blind Esc) |
| `stuck-input` | `ACTION … kind=stuck-input text=…` | `runStuckInputDetector` | Text sat unsubmitted in an IDLE agent's composer ≥`STUCK_INPUT_MIN` (5m); re-emits per `STUCK_INPUT_RE_EMIT_MIN` (15m). Alert-only unless `STUCK_INPUT_AUTO_SUBMIT=1` |
| `idle-blocked` | `ACTION … kind=idle-blocked ticks=N` | `runIdleBlockedDetector` | Pattern-NEGATIVE backstop (GH-698 A1): empty composer + no spinner + no tool subprocess for `Q_IDLE_CONFIRM_TICKS` (3) consecutive ticks mid-workflow — usually a prompt the question detector cannot parse (permission/trust/login dialog) or a turn that ended without the workflow advancing. Exempt in `complete`/`wait_merge`/`ci`/`cleanup`/`reports` and on announced human-waits. ALERT-ONLY (never auto-kill/restart), and silence auto-restart is held `IDLE_BLOCKED_HOLD_MIN` (30m) from the first alert; re-emits per `IDLE_BLOCKED_RE_EMIT_MIN` (15m) |
| `no-progress` | `ACTION … kind=no-progress elapsedMin=N` | `runNoProgressCheck` | Worktree unchanged ≥`NO_PROGRESS_ALERT_MIN` (45m) while the pane LOOKS active — the backstop for panes that defeat silence detection (tail -f, polling loops). Re-emits per `NO_PROGRESS_RE_EMIT_MIN` (60m) |
| `DEAD-END-HOLD` | log-only | `actions.freeDeadEndSlot` | A question-pending dead-end with NO queued work to rotate to holds the session alive instead of killing it (one line per 30m) |
| `TICK-ERROR` / `DAEMON-CRASH` / `CONDUCTOR-USURPED` | un-kinded fault lines — these DO wake (deliberately, alongside daemon start/exit, `CONDUCTOR-EXISTS`/`CONDUCTOR-FORCED`, syncManifest/maybeFillPool failures, `ALERT-DROPPED`) | main loop guards | A detector threw (session skipped, others unaffected) / an exception escaped (daemon logs + keeps ticking) / the lock was force-taken by a newer conductor (this one exits) |
| `HEARTBEAT N active, X pr-ready, Y pr-broken, Z pr-pending, W wedged ‖ …` | logfile + `_heartbeat.json` only — NO beat ever wakes, not even a state-change beat (state changes reach the conductor via their own kind-specific ACTION alerts) | `maybeEmitHeartbeat` (main loop) | Rate-limited between `HEARTBEAT_MIN` (default 30m) and `HEARTBEAT_MAX_MIN` (default 120m) when state is unchanged; a state-change beat is still written immediately |

## Recommended Monitor filter

Use this exact regex:

```
ACTION|TICK-ERROR|DAEMON-CRASH|CONDUCTOR-|DEAD-END-HOLD
```

The stderr wake channel is now pre-curated (GH-680): only `ACTION` lines for the 17 default wake kinds plus real faults ever reach it — so this filter is **defense-in-depth, not load-bearing**. `spinner-hang`, `no-progress`, `kill-during-ci`, and `stop-condition-met` now DO arrive as waking `ACTION` lines (they were silent between the initial GH-680 commit and this fix), and so do `commit-stall` crossings ≥`COMMIT_STALL_WAKE_MIN` (GH-698). There is no `QUESTION-DETECTED` or `SESSION-GONE` token — questions arrive as `ACTION {json}` with `kind=question-pending`. `HEARTBEAT` and `kind:'log-only'` info chatter (NUDGE, AUTO-RESTART announces/skips, POOL-FILL, SLOT-FREED, pr-pending, low-threshold commit-stall, RESOLVED, DEAD-END-HOLD, phase-advance, …) never hit stderr — read them in `/tmp/maestro-conduct.log` when diagnosing.

Every `ACTION` payload now carries `action_required: true` on EVERY repeat of an actionable kind (not just the first — operators tuned out `[REPEAT N]` events while agents burned dead-end strikes) and, where mechanical, a copy-paste-able `unblockCmd`. Re-wake cadence is tiered (GH-698): repeats of a BLOCKING kind (action-required — the agent is idle-waiting on the operator) re-wake on a flat `BLOCKING_REWAKE_MIN` cadence that never decays, while cosmetic kinds back off exponentially per `PENDING_REWAKE_MIN`/`PENDING_REWAKE_MAX_MIN` (see `reference/env-vars.md`); every repeat still lands in the jsonl + tmux pane + banner. When the conductor observes a condition clear (composer emptied, prompt answered, spinner gone, worktree progressing), it appends an `alert-resolved` record that retires the incident from the PENDING DECISIONS banner immediately instead of letting it nag out its 90m window. With `MAESTRO_STOP_GUARD=1` set in the conducting session, the Stop hook refuses to end a turn while unacked `action_required` alerts exist — engage or ack, never "standing by".

`stop-condition-met` is a **positive** signal — the ticket's compiled oracle exited 0, the agent finished, its slot was freed and the next queued ticket bootstrapped. `pr-ready` is the **positive** signal — when you see it, the agent's PR is CLEAN and all checks are green; merge it (or hold per `[[never-auto-merge-pr]]`). `wedged` is the **escalation** signal — auto-restart loop hit its cap; operator must inspect. `HEARTBEAT` is the periodic fleet summary in the logfile/`_heartbeat.json`; it never appears on the wake channel.

> **Wake filter.** NO heartbeat ever wakes the conductor model — not even a state-change beat (those are written to the logfile + `_heartbeat.json` immediately, and the state change reaches the conductor via its own kind-specific ACTION alert). The `CONDUCT_WAKE_EVENTS` allowlist (see `reference/env-vars.md`) controls which kinds wake the model; a custom list REPLACES the default (fail-closed), and `all`/`*` restores always-wake.

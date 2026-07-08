# Env tunables

On-demand reference for `/orchestrate`. The injected `SKILL.md` points here so
the daemon knob table stays out of the hot context; read this when you need a
specific variable's default or effect.

| Variable | Default | What it tunes |
|---|---|---|
| `MAESTRO_NS` | (unset) | Namespace key (`[A-Za-z0-9_-]+`). Isolates state/log/alert/inbox/lock + tmux session names (`<ns>/<TICKET>-work`) so N maestro instances run on one machine without racing. Set it in each project's `.envrc`. See `docs/OPERATOR_PLAYBOOK.md` → "Running concurrent maestro instances". |
| `MAESTRO_FORCE` | (unset) | `1` takes over a live per-namespace conductor lock instead of refusing to start. |
| `WORKTREES_BASE` | — | Where worktrees live |
| `REPO_NAME` | `claude-plugin-work` | Resolves to `<base>/<repo>-<ticket>` worktree path |
| `BASE_BRANCH` | `main` | Branch the worktree forks from |
| `SILENCE_LIMIT_SEC` | 300 | Auto-restart after this much pane silence |
| `Q_WAIT_MIN` | 3 | Question-pending alert delay |
| `TICK_SEC` | 60 | Daemon tick cadence |
| `COMMIT_STALL_MIN` | 30 | Floor below which commit-stall is suppressed |
| `PR_STATUS_RE_EMIT_MIN` | 30 | Cooldown between re-emits of same PR state |
| `RESTART_LOOP_THRESHOLD` | 3 | Restarts within window before declaring WEDGED |
| `RESTART_WINDOW_MIN` | 30 | Rolling window for restart-loop counter |
| `WEDGED_QUIET_MIN` | 60 | How long to suppress restarts after WEDGED |
| `CONDUCT_WAKE_EVENTS` | (actionable set) | Comma-separated allowlist of event kinds that wake the conductor model. Defaults to the actionable alert kinds (`pr-ready`, `pr-broken`, `wedged`, `question-pending`, `nudges-exhausted`, `dead-end`, …); benign `HEARTBEAT` beats are excluded so an idle fleet does not burn model turns. Unknown kinds never match (fail-closed to "does not wake"); `all` or `*` restores pre-680 always-wake behavior. |
| `HEARTBEAT_MIN` | 30 | Minimum heartbeat cadence — floor between unchanged-state beats. State-change beats still emit immediately regardless of this floor. |
| `HEARTBEAT_MAX_MIN` | 120 | Maximum heartbeat cadence — a forced beat emits at least this often even when nothing changed, so the fleet summary never goes fully silent. |
| `ORACLE_TIMEOUT_MS` | 30000 | Per-tick wall-clock budget for a stopCondition oracle |
| `AUTO_FREE_STOP_CONDITION` | (on) | Set `0` to disable stop-condition kill/rotate |
| `AUTO_BOOTSTRAP_NEXT` | (off) | Set `1` so the conductor tops the pool up from the queue |
| `PROGRESS_FRESH_MIN` | 10 | Worktree change younger than this suppresses spinner/phase-stall/restart actions (agent is WORKING, however the pane looks) |
| `Q_RE_NUDGE_MIN` | 10 | Cooldown between question-pending re-alerts (was: every tick — killed waiting agents in ~2 min) |
| `Q_DEAD_END_MIN` | 45 | A question must be pending this long before dead-end rotation is even considered |
| `SPINNER_AUTO_INTERRUPT` | (off) | `1` restores blind Esc on spinner-hang; default emits a `spinner-hang` alert for the operator to judge |
| `STUCK_INPUT_MIN` / `STUCK_INPUT_RE_EMIT_MIN` | 5 / 15 | Composer-text persistence before `stuck-input` fires / re-emits |
| `STUCK_INPUT_AUTO_SUBMIT` | (off) | `1` auto-presses End+C-m on stuck composer text (careful: submits whatever is queued) |
| `NO_PROGRESS_ALERT_MIN` / `NO_PROGRESS_RE_EMIT_MIN` | 45 / 60 | No-worktree-change alert threshold / re-emit cadence |
| `NUDGE_STORM_MUTE_MIN` | 60 | Past 2× maxNudges, phase-stall reminders drop to one per this interval |
| `GH_CALL_TIMEOUT_MS` / `GIT_CALL_TIMEOUT_MS` | 15000 / 10000 | Hard caps on gh/git subprocesses inside the tick (a hung gh froze the whole daemon) |
| `MAESTRO_RESTART_MODE` | (auto) | `fresh` or `continue` forces the restart style; default: `--continue` for generic commands with a resumable conversation, fresh `/skill` for work/follow-up |
| `MAESTRO_BRANCH_TEMPLATE` | `{ticket}` | Worktree branch name template (`{ticket}`, `{ticket_lower}`). The old `-maestro` suffix default is gone (remotes rejected it); PR detection still recognizes legacy `<ticket>-maestro` branches |
| `MAESTRO_PENDING_WINDOW_MIN` | 90 | How far back the UserPromptSubmit hook surfaces unanswered actionable alerts |
| `DEAD_END_MAX_ATTEMPTS` / `DEAD_END_PROBE_GRACE_MIN` | 3 / 3 | Cross-lifecycle strikes before `blocked` / grace minutes after the diagnostic probe before a kill may proceed |
| `AUTO_FREE_CI_SLOT` | (on) | `0` disables CI-phase rotation (kill-during-ci) AND pr-ready slot freeing — independent of `AUTO_FREE_DEAD_END` |
| `COMMENT_LOOP_CYCLES` / `COMMENT_LOOP_RE_EMIT_MIN` | 3 / 60 | Fix→push→re-comment cycles before LOOP escalation / re-emit cadence |
| `AUTH_BROKEN_RE_EMIT_MIN` | 30 | Cooldown between auth-broken alerts per session |
| `MAESTRO_STOP_GUARD` | (off) | `1` in the CONDUCTING session: Stop hook exits 2 while unacked `action_required` alerts exist (ack: write the alert's ts to `~/.cache/maestro-stop-guard.state`). Leave unset in unrelated sessions |

# maestro-conduct

Active conducting loop for the maestro plugin. Keeps each `/work` agent on tempo.

## Why

Single binary, six detector passes that together cover both the "totally dead"
and "hung but emitting frames" failure modes:

1. **Pending question** — track how long a permission/menu prompt has been
   waiting. Never auto-answer; escalate to a maestro alert after `Q_WAIT_MIN`.
2. **Silence / auto-restart** — pane is "active" only when a live spinner is
   present, the token count went up, or the pane hash changed. After
   `SILENCE_LIMIT_SEC` of genuine silence, kill the `-work` session and relaunch
   `claude --dangerously-skip-permissions /work <TICKET>` in the same worktree.
   `/work` resumes from `.work-state.json`. (Ported from the original
   `maestro-conduct.sh`, which this script supersedes.)
3. **Hung spinner** — TUI spinner timer crossing `SPINNER_THRESHOLD_MIN`
   triggers an `Esc` + cue (we know the subagent is dead inside). A frame-
   updating spinner doesn't trip the silence timer, so this is its complement.
4. **Phase stall** — workflow phase has been current longer than its budget.
   Drives a per-phase escalation chain: **soft nudge → interrupt nudge → alert**.
5. **Commit stall** (implement phase only) — no commits in N min, info log.
6. **PR comments** (follow_up phase only) — unaddressed bot review comments at
   CURRENT diff positions, HEAD unchanged → soft → interrupt → alert.

## Files

| File | Role |
|---|---|
| `phase-registry.js` | Per-phase budgets + detectors + nudge policy. Single source of truth. |
| `tmux.js` | Pane capture / send-keys / session helpers. |
| `state.js` | JSON markers under `STATE_DIR` (default `/tmp/maestro-conduct-state`). |
| `workstate.js` | Reads the `/work` state file for a ticket; resolves current phase. |
| `alerts.js` | Writes maestro alerts to `/tmp/maestro-alerts.jsonl` + `maestro-alerts` tmux pane. |
| `actions.js` | `soft`, `interrupt`, `alert` — implementations of the escalation actions. |
| `detectors/question.js` | Menu/permission prompts. |
| `detectors/silence.js` | Pane-content/token-count diff — fires the auto-restart path. |
| `detectors/spinner.js` | TUI spinner timer parsing. |
| `detectors/phase-stall.js` | Stateful per-phase budget tracking. |
| `detectors/commit-stall.js` | Informational: no commits in implement phase. |
| `detectors/pr-comments.js` | Bot review comments still open at CURRENT diff positions. |

The entrypoint sits one level up at `../../maestro-conduct.js`.

## Registry pattern

Mirrors `tdd-phase-registry.js` from `work-implement`. Adding a new phase or
changing a budget is one row:

```js
implement: { budgetMin: 60, detectors: ['question', 'spinner', 'phaseStall', 'commitStall'] },
```

Per-phase exempts (e.g., long-running e2e suites) can be added via the
`exempts(ctx)` predicate without touching the main loop.

## Usage

```bash
# one shot
node plugins/maestro/scripts/maestro-conduct.js

# daemon
node plugins/maestro/scripts/maestro-conduct.js --daemon
```

Drop it into a tmux session if you want it backgrounded:

```bash
tmux new-session -d -s main-orchestrate \
  'node plugins/maestro/scripts/maestro-conduct.js --daemon'
```

## Tunables (env)

| Env | Default | What |
|---|---|---|
| `TICK_SEC` | 60 | Loop cadence in `--daemon` mode |
| `Q_WAIT_MIN` | 3 | Pending-question wait before maestro alert |
| `SILENCE_LIMIT_SEC` | 300 | Silence threshold before auto-restart |
| `SPINNER_THRESHOLD_MIN` | 15 | Spinner age that triggers interrupt |
| `SPINNER_RE_INTERRUPT_MIN` | 5 | Cooldown before re-interrupting the same hang |
| `COMMIT_STALL_MIN` | 30 | Implement-phase commit gap that logs a warning |
| `CLAUDE_BIN` | `claude` | Binary used by the silence auto-restart |
| `SKILL_NAME` | `work` | Skill name passed to the auto-restart command |
| `TICKET_PREFIX` | `GH` | Override the provider-derived session prefix |
| `STATE_DIR` | `/tmp/maestro-conduct-state` | Marker location |
| `ALERT_FILE` | `/tmp/maestro-alerts.jsonl` | Alert sink |
| `ALERT_SESSION` | `maestro-alerts` | tmux alert pane |

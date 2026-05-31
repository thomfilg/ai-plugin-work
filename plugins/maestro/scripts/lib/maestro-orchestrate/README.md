# maestro-orchestrate

Active conducting loop for the maestro plugin. Keeps each `/work` agent on tempo.

## Why

`maestro-conduct.sh` only reacts to pure tmux silence (>300s no pane output).
But a hung Claude subagent keeps emitting frame updates to its spinner —
"Synthesizing… 40m 35s ↓ 78.2k tokens" — so the silence timer never trips.
Empirically observed: dispatches stuck 40+ min with no commits, no progress.

`maestro-orchestrate` adds three detection passes the conductor misses:

1. **Pending question** — track how long a permission/menu prompt has been
   waiting. Never auto-answer; escalate to a maestro alert after `Q_WAIT_MIN`.
2. **Hung spinner** — TUI spinner timer crossing `SPINNER_THRESHOLD_MIN`
   triggers an immediate `Esc` + cue (we know the subagent is dead inside).
3. **Phase stall** — workflow phase has been current longer than its budget.
   Drives a per-phase escalation chain: **soft nudge → interrupt nudge → alert**.

## Files

| File | Role |
|---|---|
| `phase-registry.js` | Per-phase budgets + detectors + nudge policy. Single source of truth. |
| `tmux.js` | Pane capture / send-keys / session helpers. |
| `state.js` | JSON markers under `STATE_DIR` (default `/tmp/maestro-orchestrate-state`). |
| `workstate.js` | Reads the `/work` state file for a ticket; resolves current phase. |
| `alerts.js` | Writes maestro alerts to `/tmp/maestro-alerts.jsonl` + `maestro-alerts` tmux pane. |
| `actions.js` | `soft`, `interrupt`, `alert` — implementations of the escalation actions. |
| `detectors/question.js` | Menu/permission prompts. |
| `detectors/spinner.js` | TUI spinner timer parsing. |
| `detectors/phase-stall.js` | Stateful per-phase budget tracking. |
| `detectors/commit-stall.js` | Informational: no commits in implement phase. |

The entrypoint sits one level up at `../../maestro-orchestrate.js`.

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
node plugins/maestro/scripts/maestro-orchestrate.js

# daemon
node plugins/maestro/scripts/maestro-orchestrate.js --daemon
```

Drop it into a tmux session if you want it backgrounded:

```bash
tmux new-session -d -s main-orchestrate \
  'node plugins/maestro/scripts/maestro-orchestrate.js --daemon'
```

## Tunables (env)

| Env | Default | What |
|---|---|---|
| `TICK_SEC` | 60 | Loop cadence in `--daemon` mode |
| `Q_WAIT_MIN` | 3 | Pending-question wait before maestro alert |
| `SPINNER_THRESHOLD_MIN` | 15 | Spinner age that triggers interrupt |
| `COMMIT_STALL_MIN` | 30 | Implement-phase commit gap that logs a warning |
| `STATE_DIR` | `/tmp/maestro-orchestrate-state` | Marker location |
| `ALERT_FILE` | `/tmp/maestro-alerts.jsonl` | Alert sink |
| `ALERT_SESSION` | `maestro-alerts` | tmux alert pane |

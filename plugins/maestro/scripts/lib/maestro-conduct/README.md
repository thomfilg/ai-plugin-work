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
| `SILENCE_LIMIT_SEC_FOLLOWUP` | `1800` (registry default) | Per-skill silence threshold override for `follow-up`. Read per-call by `detectors/silence.js`. |

## skill-adapter

The maestro daemon multiplexes the same detector loop across multiple
agent skills (today: `work` and `follow-up`). Each skill is a single row
in `skill-registry.js` and provides four pieces of behavior the loop
consumes through one seam.

### Registry row shape

Returned by `skillRegistry.get(name)` — see
`shared/skill-registry-rows.js` for the row factories.

| Field | Type | Meaning |
|---|---|---|
| `stateFile` | `(ticket) => string \| null` | Absolute path to the per-skill state file under `tasks/<ticket>/`. `work` returns `.work-state.json`; `follow-up` returns `null` (no `/work` state; the skill is stateless). |
| `snapshot(ticket)` | `(ticket) => { exists: boolean, phase?: string, raw?: object, source: 'work-state' \| 'follow-up' \| 'none' }` | One-shot read used by `ctxFor` to resolve the active phase. Must never throw on a missing file — return `{ exists: false, source }` instead. |
| `isHealthyIdle(ctx)` | `(ctx) => boolean` | Predicate that exempts a skill from the phase-stall escalation chain when "idle is the correct state" (e.g. `follow-up` between bot comment polls). |
| `silenceLimitSec` | `number` | Default silence threshold for the skill. Overridden per-call by `SILENCE_LIMIT_SEC_<SKILL_UPPER>` (e.g. `SILENCE_LIMIT_SEC_FOLLOWUP`). |

### State-file locations

| Skill | File | Note |
|---|---|---|
| `work` | `tasks/<ticket>/.work-state.json` | Authored by `/work` itself. |
| `follow-up` | _none_ | `follow-up` is stateless; `snapshot()` returns `{ source: 'follow-up' }`. |

The skill identity itself is persisted at `tasks/<ticket>/.maestro-skill`
(`work` is the default when the file is absent — non-regressive for
existing tickets). `skillRegistry.readTicketSkill(ticket)` resolves it.

### Healthy-idle predicate semantics

`isHealthyIdle(ctx)` MUST return `true` only when:

1. The skill expects the agent to be idle in the current phase, AND
2. The conductor would otherwise treat the silence as a stall.

For `work` it always returns `false` (silence is never healthy). For
`follow-up` it returns `true` when the ctx is between PR-comment polls,
which is the PR #504 wedge the maestro skill is designed to avoid.

### Silence-threshold env var conventions

Per-call resolution order in `detectors/silence.js#resolveSilenceLimit`:

1. `ctx.skill === 'follow-up'` AND `$SILENCE_LIMIT_SEC_FOLLOWUP` set → that value
2. `skillRegistry.get(ctx.skill).silenceLimitSec`
3. `$SILENCE_LIMIT_SEC` (work-only fallback)
4. Hard default `300`

Naming convention for new skills: `SILENCE_LIMIT_SEC_<SKILL_UPPER>`
where `<SKILL_UPPER>` is the skill name uppercased with `-` replaced
by `_`.

### Skill-prefixed log lines

The conductor logs silence-path events with a skill-aware token so
`grep '\[GH-\d\+:follow-up\]' /tmp/maestro-conduct.log` separates
follow-up from work traffic. Format (single source of truth —
`detectors/silence.js#formatLogLine`):

```
[<TICKET>:<skill>] <kind>: <silenceSec>s
```

Examples:

```
[GH-514:follow-up] silence: 120s
[GH-514:work] silence: 301s
```

Missing `skill` defaults to `work` so existing `/work` log shape stays
bit-for-bit unchanged (AC5).

### Adding a new skill (registry row)

1. Add a row factory in `shared/skill-registry-rows.js` — return the
   four fields above.
2. Register it in `skill-registry.js`'s `REGISTRY` table.
3. Add `SILENCE_LIMIT_SEC_<SKILL_UPPER>` to the Tunables table above
   (and document its default).
4. Add tests in `__tests__/maestro-skill-registry.test.js` that exercise
   the new row through `get()`, `snapshot()`, and `isHealthyIdle()`.

The detector loop, the auto-restart launcher, and the log emit path
all read through the registry — no new switch/case is needed at any
call site.

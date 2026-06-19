---
name: orchestrate
description: Orchestrate multiple /work agents in parallel. Use when the user says "orchestrate these tickets", "launch agents", "bootstrap multiple tickets", "run all of these in parallel", "start a swarm", or lists several ticket IDs to work on simultaneously. Creates one tmux session per ticket in its own worktree, auto-restarts silent agents, and surfaces real questions to the operator.
argument-hint: <ticket-ids...> | queue=… [poolSize=N] [command=/X] [stopCondition="…"] [save=name|schema=name]
user-invocable: true
allowed-tools: Bash, Read, Write, AskUserQuestion, Skill
---

# /orchestrate

Run several `/work GH-<N>` agents at once. Each ticket gets its own worktree at `${WORKTREES_BASE}/${REPO_NAME}-<TICKET>`, its own `<TICKET>-work` tmux session, and its own pane that the conductor watches.

## Usage

```
/orchestrate <ticket-ids...>
```

Examples:
- `/orchestrate GH-397 GH-398 GH-414` — bootstrap + launch three agents in parallel
- `/orchestrate 397 398` — bare numbers are accepted; project key is prepended

## Parameterized form (queue / pool / command / stopCondition / schema)

```
/maestro:orchestrate queue=5915,5956,5945 poolSize=1 command=/qc-work \
    stopCondition="when /follow-up skill says that it passed" save=opera1
/maestro:orchestrate queue=5915,5956,5945 poolSize=1 schema=opera1
```

| Param | Meaning |
|---|---|
| `queue=` | Comma-separated ticket ids (bare numbers get the project prefix). Per-run; NEVER saved into a schema. |
| `poolSize=` | Max concurrent `-work` sessions (manifest `slots`). The conductor tops the pool up from the queue as slots free (needs `AUTO_BOOTSTRAP_NEXT=1`). |
| `command=` | The skill each queued ticket runs (e.g. `/qc-work`). Whitelisted skills (`work`, `follow-up`) run as-is; ANY other command is allowed ONLY when a `stopCondition` is also given (it then runs under a generic conductor row — the oracle, not a bespoke registry row, defines "done"). |
| `stopCondition=` | Natural-language completion condition. The skill COMPILES it once into a deterministic shell oracle (see below). The daemon then evaluates that oracle every tick; exit 0 ⇒ the agent is done ⇒ kill + free slot + bootstrap the next queued ticket. |
| `save=` | After compiling, persist `{poolSize, command, stopCondition.oracle}` as a reusable named schema (synapsys-style store). `queue` is excluded. |
| `schema=` | Load a saved schema's `poolSize`/`command`/`oracle`; combine with this run's `queue=`. Explicit CLI params override the schema (warn on conflict). The pinned oracle is reused as-is unless `recompile=true`. |

### Compiling `stopCondition` into an oracle (LLM, once — never at eval time)

The constraint is hard: **the daemon must NEVER call an LLM to judge "is it done".** So you (the skill) translate the prose into a shell predicate up front:

1. Parse the named skill from the condition (e.g. `/follow-up`).
2. Locate its runnable script and a machine-readable verdict — exit code, JSON field, or marker file. For `/follow-up`: `follow-up-next.js` reaches `action:'complete'` (state `complete`) only after re-verifying the PR is mergeable, CI green, comments resolved. Compile to:
   ```sh
   node "$FOLLOWUP/follow-up-next.js" "$TICKET" --json | jq -e '.action=="complete"'
   ```
   (`$TICKET` and `$WORKTREE` are injected into the oracle's env by the conductor — do not interpolate them into the command string.)
3. The oracle must exit 0 iff done, non-zero otherwise. Keep it cheap (runs every tick × every session).
4. **Refuse to compile** if the named skill exposes no deterministic verdict (pure-LLM skill). Surface via `AskUserQuestion`: "give me a shell predicate, or pick another condition" — do NOT emit an oracle that would need LLM evaluation.

### Saving / reusing schemas (synapsys-mirrored store)

Schemas persist as one markdown-with-frontmatter file per name in a tiered, marker-gated store (`local`/`worktree`/`global`/`shared`), exactly like synapsys memories. CLI: `node scripts/maestro-schema.js {init|save|list|show|delete}`.

- **No default tier.** When `save=` (or any store write) needs a tier and none was passed, `AskUserQuestion` to pick — recommend `worktree` when `git worktree list` shows >1 entry, else `local`; offer `global` (per-project) and `shared` (reused across ALL projects). If the chosen tier has no store yet, run `maestro-schema.js init <tier>` first (idempotent).
- **`save=opera1`** → compile the oracle, then `maestro-schema.js save opera1 --tier=<kind> --pool=N --command=/qc-work --stop-source="…" --stop-oracle='…' --compiled-from='follow-up@<ver> (follow-up-next.js)'`. Show a one-time note that the oracle runs as shell on every tick.
- **`schema=opera1`** → `maestro-schema.js show opera1`. If the name exists in >1 tier, `AskUserQuestion` to disambiguate. Reuse the pinned oracle as-is.
- **`schema=` omitted but reuse wanted** → `maestro-schema.js list` → `AskUserQuestion` menu of saved schemas.

### Managing saved schemas

These are management-only commands (no `queue` needed) — invoked when the user asks to see or remove saved schemas:

| Intent | Action |
|---|---|
| "list schemas" / "what schemas do I have" | `node scripts/maestro-schema.js list` → render name, tier, poolSize, command, stopSource per row |
| "show opera1" | `node scripts/maestro-schema.js show opera1` (errors if the name exists in >1 tier) |
| "delete opera1" / "forget that schema" | `node scripts/maestro-schema.js delete opera1` — if it exists in >1 tier, pass `--tier=<kind>`. Confirm before deleting (it is permanent; mirror synapsys's never-`rm`-without-ack posture). |

When the user says "delete a schema" without naming one, `list` first, then `AskUserQuestion` with the names, then `delete` the chosen one.

### Launching a parameterized run

Seed the manifest with the command + compiled oracle so a daemon restart can't revert to `/work`:

```
node scripts/maestro-session.js init <topic> <poolSize> \
    --command=<cmd> --stop-oracle='<oracle>' --stop-source='<prose>' \
    5915:1 5956:2 5945:3 …
```

Then bootstrap the first `poolSize` tickets, passing the command and (for a non-whitelisted command) `--allow-generic` so the whitelist is relaxed for the oracle-backed launch:

```
bash scripts/maestro-bootstrap.sh --skill=qc-work --allow-generic 5915
```

`--allow-generic` is required only for commands outside the `work`/`follow-up` whitelist; it accepts any regex-valid skill name and persists it to the per-ticket `.maestro-skill` file that the conductor reads on restart. Finally start the daemon with `AUTO_BOOTSTRAP_NEXT=1` so it tops the pool up from the queue as each ticket's oracle frees a slot.

## What it does

1. Bootstrap each ticket via `scripts/maestro-bootstrap.sh`:
   - Fetch `origin/${BASE_BRANCH:-main}`
   - Create worktree at `${WORKTREES_BASE}/${REPO_NAME}-<TICKET>` on a new branch
   - Launch tmux session `<TICKET>-work` running `claude --dangerously-skip-permissions '/work <TICKET>'` in that worktree
   - Idempotent — skips tickets whose worktree already exists
2. Start the orchestrator via `node scripts/maestro-conduct.js --daemon` (pipe through the Monitor tool so each emitted line becomes a chat notification). The orchestrator handles all detection (questions, silence/auto-restart, hung spinner, phase budget, unaddressed PR comments).
3. Print the initial pulse snapshot.

## After launch

- **Real questions** from any agent surface as `[<SESSION>] QUESTION-DETECTED: …` lines. Handle them via `tmux send-keys -t <SESSION>` against the agent pane.
- **Silent agents** auto-restart after `SILENCE_LIMIT_SEC` (default 300s). `/work` is resumable from `.work-state.json`.
- **Snapshot** anytime with `bash plugins/maestro/scripts/maestro-pulse.sh` (or `/pulse`).

## Daemon event vocabulary (the only thing your Monitor filter should match)

The .js daemon emits exactly these event kinds. Anything else is bookkeeping noise — do not subscribe to it. Each kind below is dedup'd as noted; if you see it, it carries new information.

| Event | Shape | Emitted by | Dedup |
|---|---|---|---|
| `QUESTION-DETECTED` | `[<S>] QUESTION-DETECTED: …` + structured `ACTION` row | `detectors/question.js` | Per-session, fires once when prompt sits ≥`Q_WAIT_MIN` minutes |
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
| `commit-stall NNNm` | `<S> commit-stall NNNm in phase=… (threshold=TTTm)` | `runCommitStallDetector` | **Threshold-only**: emits at `[30, 60, 120, 240, 480]` minutes, at most 5 lines per stall |
| `stop-condition-met` | `ACTION … kind=stop-condition-met oracle=…` + `<S> STOP-CONDITION-MET — tmux killed, slot freed` | `stop-condition.maybeStopOnOracle` → `actions.freeStopConditionSlot` | Once per ticket lifecycle (`stop-condition` marker); ticket marked `done` |
| `HEARTBEAT N active, X pr-ready, Y pr-broken, Z pr-pending, W wedged ‖ …` | log-only | `maybeEmitHeartbeat` (main loop) | Once per `HEARTBEAT_MIN` (default 30m); always emits even when nothing else changed |

## Recommended Monitor filter

Use this exact regex. Anything outside it is noise:

```
QUESTION-DETECTED|AUTO-RESTART|SESSION-GONE|NUDGE|ACTION|pr-ready|pr-broken|stop-condition-met|wedged|WEDGED|HEARTBEAT|commit-stall
```

`stop-condition-met` is a **positive** signal — the ticket's compiled oracle exited 0, the agent finished, its slot was freed and the next queued ticket bootstrapped. `pr-ready` is the **positive** signal — when you see it, the agent's PR is CLEAN and all checks are green; merge it (or hold per `[[never-auto-merge-pr]]`). `wedged` is the **escalation** signal — auto-restart loop hit its cap; operator must inspect. `HEARTBEAT` is the periodic forced re-read; never ignore it.

## Env

| Variable | Default | What it tunes |
|---|---|---|
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
| `HEARTBEAT_MIN` | 30 | Heartbeat cadence |
| `ORACLE_TIMEOUT_MS` | 30000 | Per-tick wall-clock budget for a stopCondition oracle |
| `AUTO_FREE_STOP_CONDITION` | (on) | Set `0` to disable stop-condition kill/rotate |
| `AUTO_BOOTSTRAP_NEXT` | (off) | Set `1` so the conductor tops the pool up from the queue |

## After launch

- **Real questions** from any agent surface as `[<SESSION>] QUESTION-DETECTED: …` lines. Handle them via `tmux send-keys -t <SESSION>` against the agent pane.
- **Silent agents** auto-restart after `SILENCE_LIMIT_SEC` (default 300s). `/work` is resumable from `.work-state.json`.
- **PR ready** surfaces as `pr-ready` — operator merges per `[[never-auto-merge-pr]]`.
- **PR broken** surfaces as `pr-broken` with failing-check list — orchestrator nudges the originating agent to fix.
- **Wedged sessions** suppress further restarts; operator must inspect the pane to unwedge.
- **Snapshot** anytime with `bash plugins/maestro/scripts/maestro-pulse.sh` (or `/pulse`).

## Unblocking stuck agents — protocol

When a `kind:"question-pending"` event fires, the agent is asking the orchestrator how to proceed. Answer **within Q_WAIT_MIN minutes** — 3 repeats → DEAD-END + `freeDeadEndSlot` kills the session. Follow this order:

### 1. Bypass check — refuse any of these

- Fake RED/GREEN/REFACTOR evidence (stash, delete, re-record without doing the work)
- `work-state.js set-step`, `set-check`, `add-error`, `set-test-enhancement`
- Manual `transition` to skip a step without delegating its work via Skill/Task/Agent
- `userApproval=true` fabricated in any state file
- `--no-verify`, `--no-gpg-sign`, or any commit-hook-skip flag
- **Patching the plugin cache from within a /work ticket** (`~/.claude/plugins/cache/...`) — transient (next sync wipes), global (affects every workflow), out of scope

If every option in the menu is a bypass → surface to operator with analysis. Do not pick one to "make it move."

### 2. Legit-block check

Verify the agent already did the real work the gate is checking:
- RED gate → failing test exists (or task `Type=docs`/`visual-only` with deliverables on disk)
- GREEN gate → verification command exits 0 and the deliverables exist
- Docs/visual-only → the documented files are written

If real work IS done and a gate still blocks → the blocker is almost always a **bad artifact** (tasks.md, brief.md, spec.md, work-state.json), not missing work.

### 3. Fix the artifact, not the gate

This is **not a bypass** — it's correcting a wrong document. Common cases and fixes:

| Symptom | Fix |
|---|---|
| GREEN recorder rejects silent `grep -q` Test Command (`tdd-phase-state.js` "empty-command trap") | Edit tasks.md to drop `-q` |
| `Type=wiring` on task whose AC says "docs-only" | Edit tasks.md to set `Type=docs` |
| Test Command path is wrong | Edit tasks.md path |
| Brief gate question already answered in brief.md | Edit brief.md to include the answer |
| Scope-blocked file edit but file legitimately belongs in scope | Edit tasks.md Files-in-scope list |

The orchestrator can edit these files from outside the ticket's active phase even when the in-phase hook blocks the agent. Edit directly, then `tmux send-keys -t <TICKET>-work` with: `I fixed <path>:<line>. Retry.`

### 4. File a bug at the root cause

Always upstream, not at the symptom:

| Symptom | Root cause to file |
|---|---|
| GREEN deadlocks `Type=docs` task | "split-in-tasks validator allowed Type/AC mismatch" + "GREEN missing docs-exempt fallback that RED has" |
| brief_gate Q loops endlessly | "brief-writer produced ambiguous questions" |
| Tasks have wrong scope | "split-in-tasks scope detection" |
| Hook blocks legitimate in-scope edit | "protect-task-scope scope detection" |

Search existing issues first (`gh issue list --search`). Use 2-3 keywords from the proposed title; check closed too. Link related issues.

### 5. Long-term over patch

Given the choice between:
- "Patch the plugin cache to unblock today" — transient, global
- "Edit the source-of-truth document" — scoped, persistent

…always pick the source-of-truth fix. Cache patches get wiped on next plugin sync and affect every workflow on the machine.

### Pool discipline

`pool=N` means at most N concurrent `-work` sessions. When a ticket dead-ends or you kill one (e.g. GH-511 wedged on operator decision held the slot for hours), free the slot via `maestro-cleanup.js <TICKET> --tmux` and bootstrap the next queued ticket.

## Anti-patterns

- Do **not** kill sessions belonging to other tickets — scoped per `<TICKET>-work` only.
- Do **not** auto-merge PRs without operator approval; the orchestrator does not call `gh pr merge`.
- Do **not** ignore `pr-ready` — that's the positive signal you were waiting for.
- Do **not** ignore `HEARTBEAT` — it is the periodic forced re-read that exists specifically because operators desensitize to repeated noise.
- Do **not** let `question-pending` re-fire to DEAD-END — answer within Q_WAIT_MIN.
- Do **not** allow agents to patch `~/.claude/plugins/cache/` from inside a /work ticket — revert immediately from `~/.claude/plugins/marketplaces/.../scripts/.../task-next.js` (or equivalent pristine source).
- Do **not** reply `.` or `!` to `question-pending` or `pr-ready` events — those are actionable, not routine.
- The inbox at `/tmp/claude-agent-inbox/<TICKET>.log` is human-facing; agents do not read it. Talk to agents via `tmux send-keys`.

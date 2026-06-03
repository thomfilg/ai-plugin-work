---
name: orchestrate
description: Orchestrate multiple /work agents in parallel. Use when the user says "orchestrate these tickets", "launch agents", "bootstrap multiple tickets", "run all of these in parallel", "start a swarm", or lists several ticket IDs to work on simultaneously. Creates one tmux session per ticket in its own worktree, auto-restarts silent agents, and surfaces real questions to the operator.
argument-hint: <ticket-ids...>
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
| `HEARTBEAT N active, X pr-ready, Y pr-broken, Z pr-pending, W wedged ‖ …` | log-only | `maybeEmitHeartbeat` (main loop) | Once per `HEARTBEAT_MIN` (default 30m); always emits even when nothing else changed |

## Recommended Monitor filter

Use this exact regex. Anything outside it is noise:

```
QUESTION-DETECTED|AUTO-RESTART|SESSION-GONE|NUDGE|ACTION|pr-ready|pr-broken|wedged|WEDGED|HEARTBEAT|commit-stall
```

`pr-ready` is the **positive** signal — when you see it, the agent's PR is CLEAN and all checks are green; merge it (or hold per `[[never-auto-merge-pr]]`). `wedged` is the **escalation** signal — auto-restart loop hit its cap; operator must inspect. `HEARTBEAT` is the periodic forced re-read; never ignore it.

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

## After launch

- **Real questions** from any agent surface as `[<SESSION>] QUESTION-DETECTED: …` lines. Handle them via `tmux send-keys -t <SESSION>` against the agent pane.
- **Silent agents** auto-restart after `SILENCE_LIMIT_SEC` (default 300s). `/work` is resumable from `.work-state.json`.
- **PR ready** surfaces as `pr-ready` — operator merges per `[[never-auto-merge-pr]]`.
- **PR broken** surfaces as `pr-broken` with failing-check list — orchestrator nudges the originating agent to fix.
- **Wedged sessions** suppress further restarts; operator must inspect the pane to unwedge.
- **Snapshot** anytime with `bash plugins/maestro/scripts/maestro-pulse.sh` (or `/pulse`).

## Anti-patterns

- Do **not** kill sessions belonging to other tickets — scoped per `<TICKET>-work` only.
- Do **not** auto-merge PRs without operator approval; the orchestrator does not call `gh pr merge`.
- Do **not** ignore `pr-ready` — that's the positive signal you were waiting for.
- Do **not** ignore `HEARTBEAT` — it is the periodic forced re-read that exists specifically because operators desensitize to repeated noise.
- The inbox at `/tmp/claude-agent-inbox/<TICKET>.log` is human-facing; agents do not read it. Talk to agents via `tmux send-keys`.

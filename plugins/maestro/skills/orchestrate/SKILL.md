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

## Env

`WORKTREES_BASE`, `REPO_NAME`, `BASE_BRANCH`, `SILENCE_LIMIT_SEC` — see plugin README.

## Anti-patterns

- Do **not** kill sessions belonging to other tickets — scoped per `<TICKET>-work` only.
- Do **not** auto-merge PRs without operator approval; the orchestrator does not call `gh pr merge`.
- The inbox at `/tmp/claude-agent-inbox/<TICKET>.log` is human-facing; agents do not read it. Talk to agents via `tmux send-keys`.

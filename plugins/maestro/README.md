# Maestro

Multi-agent orchestrator for `/work`-style ticket-to-PR flows.

When you run several `/work GH-N` agents in parallel — one per ticket, each in its own worktree — you need to (a) launch them, (b) keep them moving when they stall, and (c) react when one asks a real question. Maestro packages the operator tooling for that.

## Components

### `scripts/maestro-conduct.sh`

The conductor. Polls every `GH-<N>-work` tmux session every 60s. Per session:

1. **Surface real questions** — emits one line to stdout when the pane shows a `Do you want to proceed?` / `Yes/No` / `Choose:` style prompt. Designed to be piped through Claude Code's Monitor tool so each line becomes a notification.
2. **Detect genuine silence** — active = live spinner glyph present (`✻ Jitterbugging…`) OR token-count delta OR pane-hash delta across polls. Static status-bar tokens alone do NOT count. (Earlier iterations falsely classified idle panes as active because their status bars always contained the string `tokens`.)
3. **Auto-restart on silence** — when a session is genuinely silent for `SILENCE_LIMIT_SEC` (default 300s), kill the session and relaunch `claude --dangerously-skip-permissions '/work <TICKET>'` in the same worktree. `/work` is resumable via `.work-state.json` so the agent picks up where it left off.

Auto-discovers `GH-[0-9]+-work` sessions via `tmux list-sessions` — no SESSIONS array to maintain.

### `scripts/maestro-bootstrap.sh`

Bootstraps multiple tickets in one shot: fetches main, creates `<REPO>-<TICKET>` worktrees, launches a `<TICKET>-work` tmux session running `claude --dangerously-skip-permissions '/work <TICKET>'`. Idempotent — skips tickets that already have a worktree.

### `scripts/maestro-status.sh`

Quick status table: each agent's last commit, current step, pane spinner, token count, plus PR state for every related PR. Run-once snapshot, not a watcher.

### `scripts/maestro-signal.js` / `maestro-listen.js`

File-mailbox at `/tmp/claude-agent-inbox/<TICKET>.log`. `signal` appends a line, `listen` does `tail -F` with a bell. **Note:** the listener is a human-facing alert, not an agent input pipe — the agent reads its prompt via tmux send-keys, not the inbox. The mailbox is for human-to-human coordination across multiple terminal windows.

## Skills (slash commands)

- `/orchestrate <ticket-ids>` — bootstrap + launch + start the conductor for a set of tickets
- `/conduct` — start the conductor for whatever `GH-*-work` sessions are running
- `/pulse` — print the snapshot table
- `/signal <ticket> <message>` — send a line to the mailbox

## Configuration (env vars)

| Var | Default | Effect |
|-----|---------|--------|
| `WORKTREES_BASE` | `$HOME/worktrees` | Parent dir for `<REPO>-<TICKET>` worktrees |
| `REPO_NAME` | `claude-plugin-work` | Repo basename |
| `BASE_BRANCH` | `main` | Branch to base worktrees on |
| `SILENCE_LIMIT_SEC` | `300` | Auto-restart threshold |
| `POLL_INTERVAL_SEC` | `60` | Conductor poll cadence |
| `SESSION_PATTERN` | `^GH-[0-9]+-work$` | Regex of sessions to watch |

## Status

Pre-release scaffold. Lift-and-shift of the ad-hoc tooling that lived in `/tmp` during the parallel-agent runs of 2026-05-23.

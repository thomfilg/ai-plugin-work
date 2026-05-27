# Maestro

Multi-agent orchestrator for `/work`-style ticket-to-PR flows.

When you run several `/work <TICKET>` agents in parallel — one per ticket, each in its own worktree — you need to (a) launch them, (b) keep them moving when they stall, and (c) react when one asks a real question. Maestro packages the operator tooling for that.

### Provider-derived session prefix

Session names are prefixed with the **provider-derived ticket prefix** rather than a hardcoded `GH`. Both `maestro-conduct.sh` and `maestro-bootstrap.sh` resolve the prefix via `plugins/work/scripts/workflows/lib/ticket-provider.js` (`getProviderConfig` → `projectKey` / `sanitizeTicketIdForPath`). The resolution is **fail-open**: when the provider is GitHub (`projectKey: ''`), unconfigured (returns `null`), the node shell-out fails, or the resolved value does not match `^[A-Z][A-Z0-9]*$`, the prefix falls back to `GH`. So with a Linear/Jira provider whose `projectKey` is `ECHO`, sessions are named `ECHO-<N>-work`; with GitHub (or no config) they stay `GH-<N>-work` byte-for-byte.

The `SESSION_PATTERN` default is therefore `^${PREFIX}-[0-9]+-(work|dev|listen)$` for the resolved `${PREFIX}` — never an empty-prefix pattern. `SESSION_PATTERN` is the single env override that drives discovery: its default already widens to `-(work|dev|listen)` so the `-dev`/`-listen` helper sessions `/work` spawns surface informationally. Auto-restart is gated **separately** to `-work` only, so `-dev` and `-listen` helpers are reported but never relaunched with `/work <TICKET>`.

## Components

### `scripts/maestro-conduct.sh`

The conductor. Polls every `${PREFIX}-<N>-work` tmux session every 60s (where `${PREFIX}` is the provider-derived prefix described above, default `GH`). Per session:

1. **Surface real questions** — emits one line to stdout when the pane shows a `Do you want to proceed?` / `Yes/No` / `Choose:` style prompt. Designed to be piped through Claude Code's Monitor tool so each line becomes a notification.
2. **Detect genuine silence** — active = live spinner glyph present (`✻ Jitterbugging…`) OR token-count delta OR pane-hash delta across polls. Static status-bar tokens alone do NOT count. (Earlier iterations falsely classified idle panes as active because their status bars always contained the string `tokens`.)
3. **Auto-restart on silence** — when a `-work` session is genuinely silent for `SILENCE_LIMIT_SEC` (default 300s), kill the session and relaunch `claude --dangerously-skip-permissions '/work <TICKET>'` in the same worktree. `/work` is resumable via `.work-state.json` so the agent picks up where it left off. Only `-work` sessions are restart-eligible; `-dev`/`-listen` helpers are reported but never relaunched.

Auto-discovers `${PREFIX}-[0-9]+-(work|dev|listen)` sessions via `tmux list-sessions` — no SESSIONS array to maintain. `${PREFIX}` is the provider-derived prefix (fail-open to `GH`).

### `scripts/maestro-bootstrap.sh`

Bootstraps multiple tickets in one shot: fetches main, creates `<REPO>-<TICKET>` worktrees, launches a `<TICKET>-work` tmux session running `claude --dangerously-skip-permissions '/work <TICKET>'`. Idempotent — skips tickets that already have a worktree. Bare ticket numbers are normalized with the provider-derived `${PREFIX}` (e.g. `429` → `GH-429` on GitHub, `ECHO-429` under an `ECHO` provider), and the active-sessions listing greps `^${PREFIX}-[0-9]+-work` accordingly.

### `scripts/maestro-status.sh`

Quick status table: each agent's last commit, current step, pane spinner, token count, plus PR state for every related PR. Run-once snapshot, not a watcher.

### `scripts/maestro-signal.js` / `maestro-listen.js`

File-mailbox at `/tmp/claude-agent-inbox/<TICKET>.log`. `signal` appends a line, `listen` does `tail -F` with a bell. **Note:** the listener is a human-facing alert, not an agent input pipe — the agent reads its prompt via tmux send-keys, not the inbox. The mailbox is for human-to-human coordination across multiple terminal windows.

## Skills (slash commands)

- `/orchestrate <ticket-ids>` — bootstrap + launch + start the conductor for a set of tickets
- `/conduct` — start the conductor for whatever `${PREFIX}-*-work` sessions are running (provider-derived prefix, default `GH`)
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
| `SESSION_PATTERN` | `^${PREFIX}-[0-9]+-(work\|dev\|listen)$` | Regex of sessions to discover and watch. `${PREFIX}` is the provider-derived prefix (via `ticket-provider.js`, fail-open to `GH`); GitHub/unconfigured resolves to `^GH-[0-9]+-(work\|dev\|listen)$`. The default already includes `-dev`/`-listen` helpers; only `-work` is auto-restart-eligible. |

## Status

Pre-release scaffold. Lift-and-shift of the ad-hoc tooling that lived in `/tmp` during the parallel-agent runs of 2026-05-23.

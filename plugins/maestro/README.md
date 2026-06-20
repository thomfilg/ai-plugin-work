# Maestro

Multi-agent orchestrator for `/work`-style ticket-to-PR flows.

When you run several `/work <TICKET>` agents in parallel — one per ticket, each in its own worktree — you need to (a) launch them, (b) keep them moving when they stall, and (c) react when one asks a real question. Maestro packages the operator tooling for that.

### Provider-derived session prefix

Session names are prefixed with the **provider-derived ticket prefix** rather than a hardcoded `GH`. Both `maestro-conduct.js` (via `tmux.resolveTicketPrefix()`) and `maestro-bootstrap.sh` (via `lib/resolve-prefix.sh`) resolve the prefix from the `TICKET_PREFIX` env var (in `tmux.js`) or `plugins/work/scripts/workflows/lib/ticket-provider.js` (in the bootstrap). Both paths are **fail-open**: when the provider is GitHub, unconfigured, the node shell-out fails, or the resolved value does not match `^[A-Z][A-Z0-9]*$`, the prefix falls back to `GH`. So with a Linear/Jira provider whose `projectKey` is `ECHO`, sessions are named `ECHO-<N>-work`; with GitHub (or no config) they stay `GH-<N>-work` byte-for-byte.

The `SESSION_PATTERN` default is therefore `^${PREFIX}-[0-9]+-(work|dev|listen)$` for the resolved `${PREFIX}` — never an empty-prefix pattern. `SESSION_PATTERN` is the single env override that drives discovery: its default already widens to `-(work|dev|listen)` so the `-dev`/`-listen` helper sessions `/work` spawns surface informationally. Auto-restart is gated **separately** to `-work` only, so `-dev` and `-listen` helpers are reported but never relaunched with `/work <TICKET>`.

## Components

### `scripts/maestro-conduct.js`

The orchestrator (single binary; replaces the previous `maestro-conduct.sh`). Per tick (every `TICK_SEC`, default 60s), each `${PREFIX}-*-work` tmux session runs through detectors registered in `lib/maestro-conduct/phase-registry.js`:

1. **Question** — pane shows `Do you want to proceed?` / menu prompt → emit `QUESTION-DETECTED`. Always wins; no nudges while the operator is being asked.
2. **Silence / auto-restart** — pane is "active" only when a live spinner glyph is present (`✻ Jitterbugging…`) OR the token count went up OR the pane hash changed. After `SILENCE_LIMIT_SEC` (default 300s) of genuine silence, kill the session and relaunch `claude --dangerously-skip-permissions '/work <TICKET>'` in the same worktree. `/work` is resumable via `.work-state.json`. Only `-work` sessions are restart-eligible.
3. **Spinner hang** — Claude TUI thinking-spinner stuck past threshold → Esc + nudge, with cooldown so the pane doesn't get flooded.
4. **Phase budget stall** — current `/work` step has been current longer than `phaseFor(phase).budgetMin` → soft → interrupt → alert escalation.
5. **Commit stall** (implement phase only) — no commits in N min, informational log.
6. **PR comments** (follow_up phase only) — unaddressed bot review comments at CURRENT diff positions, HEAD unchanged → soft → interrupt → alert.

Auto-discovers `${PREFIX}-[0-9]+-work` sessions via `tmux list-sessions` (override with `TICKET_PREFIX` env). Designed to be piped through Claude Code's Monitor tool so each emitted line becomes a notification.

### `scripts/maestro-bootstrap.sh`

Bootstraps multiple tickets in one shot: fetches main, creates `<REPO>-<TICKET>` worktrees, launches a `<TICKET>-work` tmux session running `claude --dangerously-skip-permissions '/work <TICKET>'`. Idempotent — skips tickets that already have a worktree. Bare ticket numbers are normalized with the provider-derived `${PREFIX}` (e.g. `429` → `GH-429` on GitHub, `ECHO-429` under an `ECHO` provider), and the active-sessions listing greps `^${PREFIX}-[0-9]+-work` accordingly.

### `scripts/maestro-status.sh`

Quick status table: each agent's last commit, current step, pane spinner, token count, plus PR state for every related PR. Run-once snapshot, not a watcher.

### `scripts/maestro-signal.js` / `maestro-listen.js`

File-mailbox at `/tmp/claude-agent-inbox/<TICKET>.log` (per-namespace `/tmp/claude-agent-inbox/<MAESTRO_NS>/` when `MAESTRO_NS` is set). `signal` appends a line, `listen` does `tail -F` with a bell. **Note:** the listener is a human-facing alert, not an agent input pipe — the agent reads its prompt via tmux send-keys, not the inbox. The mailbox is for human-to-human coordination across multiple terminal windows.

### Running N maestro instances on one machine

Set `MAESTRO_NS=<name>` (per project / worktree) to isolate everything maestro
keys by ticket — state dir, conductor lock, log/alert sinks, the inbox, **and**
tmux session names (`<ns>/<TICKET>-work`). The conductor enforces one instance
per namespace via a lockfile and refuses (or, with `MAESTRO_FORCE=1`, takes
over) a second daemon in the same namespace. Unset = the historical
machine-global behaviour. Full recipe: `docs/OPERATOR_PLAYBOOK.md` → "Running
concurrent maestro instances".

## Skills (slash commands)

- `/orchestrate <ticket-ids>` — bootstrap + launch + start the orchestrator for a set of tickets
- `/conduct` — start the orchestrator for whatever `${PREFIX}-*-work` sessions are running (provider-derived prefix, default `GH`)
- `/pulse` — print the snapshot table
- `/signal <ticket> <message>` — send a line to the mailbox

## Configuration (env vars)

| Var | Default | Effect |
|-----|---------|--------|
| `WORKTREES_BASE` | `$HOME/worktrees` | Parent dir for `<REPO>-<TICKET>` worktrees |
| `REPO_NAME` | `claude-plugin-work` | Repo basename |
| `BASE_BRANCH` | `main` | Branch to base worktrees on |
| `SILENCE_LIMIT_SEC` | `300` | Auto-restart threshold |
| `TICK_SEC` | `60` | Orchestrator tick cadence |
| `CLAUDE_BIN` | `claude` | Binary used for auto-restart |
| `SKILL_NAME` | `work` | Skill name passed to the auto-restart command |
| `STATE_DIR` | `/tmp/maestro-conduct-state` | Per-ticket marker location |
| `LOG_FILE` | `/tmp/maestro-conduct.log` | Where event lines are appended |
| `TICKET_PREFIX` | `GH` | Override the provider-derived session prefix |
| `SESSION_PATTERN` | `^${PREFIX}-[0-9]+-(work\|dev\|listen)$` | Regex of sessions to discover and watch. `${PREFIX}` is the provider-derived prefix (via `ticket-provider.js`, fail-open to `GH`); GitHub/unconfigured resolves to `^GH-[0-9]+-(work\|dev\|listen)$`. The default already includes `-dev`/`-listen` helpers; only `-work` is auto-restart-eligible. |

## Status

Pre-release scaffold. Lift-and-shift of the ad-hoc tooling that lived in `/tmp` during the parallel-agent runs of 2026-05-23.

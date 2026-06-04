---
name: conduct
description: Conduct running /work agents. Use when the user says "start the conductor", "watch the agents", "monitor my agents", "start conducting", "babysit the agents", or asks to oversee multiple GH-<N>-work tmux sessions. Surfaces real questions to the operator and auto-restarts silent agents.
user-invocable: true
allowed-tools: Bash
---

# /conduct

Start the orchestrator on whatever `${PREFIX}-*-work` tmux sessions are already running. Use this when you bootstrapped agents manually (or via `/orchestrate`) but don't have the monitor going.

`${PREFIX}` is the **provider-derived ticket prefix**: resolved via `plugins/work/scripts/workflows/lib/ticket-provider.js` (`getProviderConfig` → `projectKey`). Resolution is fail-open — GitHub (`projectKey: ''`), an unconfigured provider (`null`), a node failure, or a value that fails the `^[A-Z][A-Z0-9]*$` check all fall back to `GH`. So an `ECHO` provider watches `ECHO-<N>-work`, while GitHub/unconfigured stays `GH-<N>-work`.

## Usage

```
/conduct
```

## What it does

Runs `node plugins/maestro/scripts/maestro-conduct.js --daemon` in the background (typically piped through Claude Code's Monitor tool so each emitted line is a notification).

Per tick (every `TICK_SEC`, default 60s) each `${PREFIX}-*-work` session runs through this detector pipeline (per-phase via `phase-registry.js`):

- **Question** — pane shows `Do you want to proceed?` / menu prompt → emit `QUESTION-DETECTED`. Always wins; no nudges while the agent is waiting on the operator.
- **Silence / auto-restart** — pane content is static (no live spinner, no token change, no hash change) for `SILENCE_LIMIT_SEC` (default 300s) → kill the session and relaunch `claude --dangerously-skip-permissions '/work <TICKET>'`. `/work` resumes from `.work-state.json`. Only `-work` sessions are restart-eligible; `-dev`/`-listen` helpers are surfaced informationally.
- **Spinner hang** — Claude TUI spinner stuck >threshold → Esc + nudge (cooldown so we don't flood the pane).
- **Phase budget stall** — current `/work` step has been current longer than `phaseFor(phase).budgetMin` → soft → interrupt → alert escalation.
- **Commit stall** (implement phase only) — no commits in N min, surfaces as info log.
- **PR comments** (follow_up phase only) — unaddressed bot review comments at CURRENT diff positions, HEAD unchanged → soft → interrupt → alert.

## Env

| Var | Default | Effect |
|-----|---------|--------|
| `SILENCE_LIMIT_SEC` | `300` | Real-silence threshold before auto-restart |
| `TICK_SEC` | `60` | Tick cadence |
| `CLAUDE_BIN` | `claude` | Binary used for auto-restart |
| `SKILL_NAME` | `work` | Skill name passed to the auto-restart command |
| `STATE_DIR` | `/tmp/maestro-conduct-state` | Per-ticket marker location |
| `LOG_FILE` | `/tmp/maestro-conduct.log` | Where event lines are appended |
| `WORKTREES_BASE` | `$HOME/worktrees` | Where worktrees live (must match bootstrap) |
| `REPO_NAME` | `claude-plugin-work` | Worktree dirname suffix (must match bootstrap) |

## Stop

The orchestrator exits on TaskStop or session end. Killing it never touches the agent sessions.

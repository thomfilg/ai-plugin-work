---
name: conduct
description: Conduct running /work agents. Use when the user says "start the conductor", "watch the agents", "monitor my agents", "start conducting", "babysit the agents", or asks to oversee multiple GH-<N>-work tmux sessions. Surfaces real questions to the operator and auto-restarts silent agents.
user-invocable: true
allowed-tools: Bash
---

# /conduct

Start the conductor on whatever `${PREFIX}-*-work` tmux sessions are already running. Use this when you bootstrapped agents manually (or via `/orchestrate`) but don't have the monitor going.

`${PREFIX}` is the **provider-derived ticket prefix**: the conductor resolves it via `plugins/work/scripts/workflows/lib/ticket-provider.js` (`getProviderConfig` → `projectKey`). Resolution is fail-open — GitHub (`projectKey: ''`), an unconfigured provider (`null`), a node failure, or a value that fails the `^[A-Z][A-Z0-9]*$` check all fall back to `GH`. So an `ECHO` provider watches `ECHO-<N>-work`, while GitHub/unconfigured stays `GH-<N>-work`.

## Usage

```
/conduct
```

## What it does

Runs `plugins/maestro/scripts/maestro-conduct.sh` in the background (typically piped through Claude Code's Monitor tool so each emitted line is a notification).

Per poll cycle (every `POLL_INTERVAL_SEC`, default 60s):

- **Active** = live spinner glyph + ellipsis in the pane, OR token count moved, OR pane hash moved. (Static text containing the word "tokens" alone does NOT count as active — that's been a long-standing false-positive.)
- **Question** = pane shows `Do you want to proceed?` / `Yes/No` / `Choose:` style prompt → emit `[<session>] QUESTION-DETECTED: …`
- **Idle** = neither active nor a question → emit `[<session>] IDLE: <Ns> silent (restart at <LIMIT>s)`
- **Auto-restart** = after `SILENCE_LIMIT_SEC` of real silence (default 300s), kill the session and relaunch `claude --dangerously-skip-permissions '/work <TICKET>'`. `/work` resumes from `.work-state.json`. Only `-work` sessions are restart-eligible.

Discovery widens to `${PREFIX}-[0-9]+-(work|dev|listen)`, so `-dev`/`-listen` helper sessions surface informationally — they are reported but never auto-restarted (only `-work` sessions are relaunched with `/work <TICKET>`).

## Env

| Var | Default | Effect |
|-----|---------|--------|
| `SILENCE_LIMIT_SEC` | `300` | Real-silence threshold before auto-restart |
| `POLL_INTERVAL_SEC` | `60` | Poll cadence |
| `SESSION_PATTERN` | `^${PREFIX}-[0-9]+-(work\|dev\|listen)$` | Sessions to discover and watch. `${PREFIX}` is the provider-derived prefix (via `ticket-provider.js`, fail-open to `GH`); GitHub/unconfigured resolves to `^GH-[0-9]+-(work\|dev\|listen)$`. The default already includes `-dev`/`-listen` helpers; only `-work` is auto-restart-eligible. |

## Stop

The conductor exits on TaskStop or session end. Killing it never touches the agent sessions.

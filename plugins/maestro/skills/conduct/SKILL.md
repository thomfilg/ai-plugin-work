---
name: conduct
description: Conduct running /work agents. Use when the user says "start the conductor", "watch the agents", "monitor my agents", "start conducting", "babysit the agents", or asks to oversee multiple GH-<N>-work tmux sessions. Surfaces real questions to the operator and auto-restarts silent agents.
user-invocable: true
allowed-tools: Bash
---

# /conduct

Start the conductor on whatever `GH-*-work` tmux sessions are already running. Use this when you bootstrapped agents manually (or via `/orchestrate`) but don't have the monitor going.

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
- **Auto-restart** = after `SILENCE_LIMIT_SEC` of real silence (default 300s), kill the session and relaunch `claude --dangerously-skip-permissions '/work <TICKET>'`. `/work` resumes from `.work-state.json`.

## Env

`SILENCE_LIMIT_SEC` (default 300), `POLL_INTERVAL_SEC` (default 60), `SESSION_PATTERN` (default `^GH-[0-9]+-work$`).

## Stop

The conductor exits on TaskStop or session end. Killing it never touches the agent sessions.

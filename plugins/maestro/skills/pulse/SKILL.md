---
name: pulse
description: Pulse — snapshot of all running agents. Use when the user says "pulse", "agent status", "what are my agents doing", "check on agents", "show agent dashboard", "snapshot", or asks for a current view of running /work sessions. One-shot table showing last commits, pane spinners, token counts, and open-PR state per agent.
user-invocable: true
allowed-tools: Bash
---

# /pulse

Print a pulse snapshot of all active `/work` agents and their PRs. Does not watch — single shot.

## Usage

```
/pulse
```

## Output sections

1. **Active /work agents** — per-session spinner + token count
2. **Recent commits per worktree** — relative timestamp + subject
3. **Open PRs** — number, mergeStateStatus, title

## Implementation

`bash plugins/maestro/scripts/maestro-pulse.sh`

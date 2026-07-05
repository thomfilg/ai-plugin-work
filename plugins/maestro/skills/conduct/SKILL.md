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

- **Question** — pane shows `Do you want to proceed?` / menu prompt / a `❯ 1.` option cursor → emit `QUESTION-DETECTED`. Always wins; no nudges while the agent is waiting on the operator. Re-alerts on a `Q_RE_NUDGE_MIN` cooldown; rotation only after `Q_DEAD_END_MIN` AND only when queued work exists.
- **Silence / auto-restart** — pane content is static for `SILENCE_LIMIT_SEC` (default 300s) AND the worktree isn't changing AND no live tool subprocess runs under the pane AND the agent isn't waiting on a human → kill + relaunch (fresh `/skill <TICKET>` for work/follow-up; `claude --continue` for generic commands). Only `-work` sessions are restart-eligible.
- **Spinner hang** — spinner past threshold with NO worktree change → `spinner-hang` alert (Esc only with `SPINNER_AUTO_INTERRUPT=1`).
- **Stuck input** — text sitting unsubmitted in an idle composer ≥5m → `stuck-input` alert (auto End+C-m with `STUCK_INPUT_AUTO_SUBMIT=1`).
- **No progress** — worktree unchanged ≥45m while the pane looks active → `no-progress` alert (the backstop for panes that defeat silence detection).
- **Phase budget stall** — the skill's phase has been current longer than `phaseFor(phase).budgetMin` AND the worktree isn't changing → soft → interrupt → alert escalation, in the agent's own skill vocabulary. Generic commands (qc-work…) have no /work phases and are never phase-coached.
- **Commit stall** (implement phase only) — no commits in N min, surfaces as info log.
- **PR comments** (follow_up phase only) — unaddressed bot review comments at CURRENT diff positions, HEAD unchanged → soft → interrupt → alert.

## Env

Full tunables table (progress gating, question cooldowns, restart modes, branch
template): `skills/orchestrate/SKILL.md` → "Env". The core ones:

| Var | Default | Effect |
|-----|---------|--------|
| `MAESTRO_NS` | (unset) | Namespace key (`[A-Za-z0-9_-]+`). When set, isolates state/log/alert/inbox/lock **and** tmux session names so N conductors run on one machine without racing (GH-622). |
| `MAESTRO_FORCE` | (unset) | `1` takes over a live per-namespace conductor lock instead of refusing. The usurped daemon detects the takeover on its next tick and exits by itself (`CONDUCTOR-USURPED`). |
| `SILENCE_LIMIT_SEC` | `300` | Real-silence threshold before auto-restart. Progress/subprocess/waiting-on-user signals defer it, so it can stay short without reaping long builds |
| `TICK_SEC` | `60` | Tick cadence |
| `CLAUDE_BIN` | `claude` | Binary used for auto-restart |
| `SKILL_NAME` | `work` | Skill name passed to the auto-restart command |
| `STATE_DIR` | `~/.cache/maestro-conduct[/<ns>]` | Per-ticket marker location (NS-derived; explicit value wins) |
| `LOG_FILE` | `/tmp/maestro-conduct[-<ns>].log` | Where event lines are appended |
| `WORKTREES_BASE` | `$HOME/worktrees` | Where worktrees live (must match bootstrap) |
| `REPO_NAME` | `claude-plugin-work` | Worktree dirname suffix (must match bootstrap) |

Concurrent instances: see the "Running concurrent maestro instances" section in
`docs/OPERATOR_PLAYBOOK.md` for the one-conductor rule and the `MAESTRO_NS`
isolation recipe.

## Stop

The orchestrator exits on TaskStop or session end. Killing it never touches the agent sessions.

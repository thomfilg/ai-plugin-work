---
name: work
description: Script-driven orchestrated workflow (v2) with auto-advance
argument-hint: <TICKET_ID or description> [--rework]
user-invocable: true
allowed-tools: Task, Bash, Read, Skill, TodoWrite
---

# /work

Run the driver script. Execute what it says. Do not improvise.

## Start

**Step 0 — open the monitor channel for this ticket FIRST.** This must be
the first tool call in the session. Each new line in the inbox file becomes
a task-notification that resumes you mid-idle — no polling, no manual nudges.

```
Monitor(node ${CLAUDE_PLUGIN_ROOT}/scripts/listen-communication.js <TICKET>)
```

Replace `<TICKET>` with `$ARGUMENTS` (the ticket id). The Monitor runs for
the lifetime of your session — do not stop it. Only the main /work
orchestrator opens this channel; dispatched subagents do NOT.

**Step 0.5 — ensure the tmux listener pane is running (idempotent).** This
must run on EVERY /work invocation, regardless of step — bootstrap is not
guaranteed to have run in this session (resumes, reworks, mid-workflow
restarts). The Monitor tool consumes events into your conversation; the
tmux pane gives a human/orchestrator a place to send nudges that the
worker can see via `tmux capture-pane`. Both are required.

```bash
LISTEN_SESSION="${ARGUMENTS%% *}-listen"
if ! tmux has-session -t "$LISTEN_SESSION" 2>/dev/null; then
  tmux new-session -d -s "$LISTEN_SESSION" \
    "node \"${CLAUDE_PLUGIN_ROOT}/scripts/listen-communication.js\" ${ARGUMENTS%% *}"
  echo "  ✓ listener started: tmux session $LISTEN_SESSION"
else
  echo "  ✓ listener already running: tmux session $LISTEN_SESSION"
fi
```

Verify a listener is attached:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/communicate.js" --check "${ARGUMENTS%% *}"
# Exits 0 if at least one listener is attached, exits 3 otherwise.
```

**Step 1 — then start the driver:**

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work-orchestrator/work-next.js "$ARGUMENTS" --init
```

## Loop

1. Parse JSON output
2. Execute the `delegate` block exactly as described below
3. Re-run work-next.js for the next instruction
4. Repeat until `action: "complete"`

## How to execute `delegate`

| delegate.type | Do this |
|---------------|---------|
| `bash` | Run the `command` field with Bash |
| `task` | `Task(agentType)` with the `prompt` field. Do NOT read files yourself. |
| `skill` | `Skill(name)` with the `prompt` field |

If the instruction has `parallel: true` with `delegates` array: launch ALL agents as parallel Task() calls in a single message.

## Rules

- The **only** command you run directly is `work-next.js`. Everything else comes from its instructions.
- If `action: "blocked"` → show the reason to the user and wait. Do NOT re-run automatically.
- **Some steps take a long time (CI monitoring can take 20+ minutes). This is normal. Do NOT cancel, interrupt, or give up.**
- Never stop until `action: "complete"`.

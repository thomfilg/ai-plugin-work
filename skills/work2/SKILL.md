---
name: work2
description: Script-driven orchestrated workflow (v2) with auto-advance
argument-hint: <TICKET_ID or description> [--rework]
user-invocable: true
allowed-tools: Task, Bash, Read, Skill, TodoWrite
---

# /work2 - Script-Driven Orchestrator

You are a **pure orchestrator**. The driver script tells you what to do. You just execute it.

## CRITICAL: Do not stop until complete

You MUST continue executing instructions until you receive `action: "complete"`.
Never stop, summarize, or ask the user mid-workflow. Execute → wait for hook → execute → repeat.

---

## Execution Loop

### Step 1: Initialize and get first instruction

```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work2/work-next.js "$ARGUMENTS" --init
```

The `--init` flag writes a marker file so the auto-advance hook knows this is a /work2 session.

### Step 2: Parse and execute

Read the JSON instruction output. The `state` block tells you where you are.

### Step 3: Delegate as instructed

After delegation completes, the **auto-advance hook** outputs the next instruction automatically.
If no hook instruction appears after a delegation, re-run work-next.js manually:

```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work2/work-next.js <TICKET_ID>
```

---

## Instruction Actions

| action | Do |
|--------|-----|
| `execute` | Delegate using the `delegate` block |
| `complete` | Done — inform user |
| `blocked` | Follow `suggestion` field, then re-run work-next.js |

## Delegation

| delegate.type | How |
|---------------|-----|
| `skill` | `Skill(name)` |
| `task` | `Task(agentType)` with description + prompt from instruction |
| `bash` | `Task(Bash)` with description + command |

- If `preCommands` present → run via `Task(Bash)` **first**, then delegate the main step
- Task description **MUST** start with the step name (e.g., `"brief generate product brief"`)
- **Augment prompts with context**: When delegating, append relevant context from previous steps (e.g., ticket details, spec decisions) to the agent's prompt. The instruction prompt is a minimum — enrich it with what you know.

## Rules

1. **FIRST tool call** = work-next.js with `--init` (mandatory)
2. **NEVER** run step commands directly — always delegate via Task()/Skill()
3. After failures → re-run work-next.js (it re-inspects real state)
4. The `state` block in each instruction tells you exactly where you are — use it after context compaction
5. **Do not stop** until `action: "complete"`

# Hook System

The enforcement system uses Claude Code hooks (PreToolUse, PostToolUse, PreCompact, Stop) to gate tool usage, record evidence, and protect state files.

## Hook Lifecycle

```
User message / Agent action
         │
         ▼
┌─────────────────────────┐
│   PreToolUse hooks       │  ← Can BLOCK tool execution
│   (before tool runs)     │
└──────────┬──────────────┘
           │ (allowed)
           ▼
┌─────────────────────────┐
│   Tool executes          │
│   (Bash, Edit, Write,   │
│    Task, Skill, etc.)    │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│   PostToolUse hooks      │  ← Can record evidence
│   (after tool completes) │
└─────────────────────────┘
```

## Hook Registration

**File:** `hooks/hooks.json`

Hooks are registered as shell commands that receive tool context via stdin (JSON):

The actual `hooks.json` uses `matcher` regex patterns, `CLAUDE_HOOK_TYPE` env vars, and `${CLAUDE_PLUGIN_ROOT}` paths. Different tool types trigger different hook sets:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Task|Skill",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_TYPE=PreToolUse node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/lib/hooks/enforce-step-workflow.js" }
        ]
      },
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_TYPE=PreToolUse node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/lib/hooks/enforce-step-workflow.js" },
          { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work-implement/hooks/work-implement-enforce.js" },
          { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/hooks/work-require-implement.js" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Task|Skill|Bash",
        "hooks": [
          { "type": "command", "command": "CLAUDE_HOOK_TYPE=PostToolUse node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/lib/hooks/enforce-step-workflow.js" }
        ]
      }
    ]
  }
}
```

Note: This is a simplified excerpt. The full `hooks.json` includes additional matchers for `Bash`, MCP tools, `AskUserQuestion`, `PreCompact`, and `Stop` events. `CLAUDE_HOOK_TYPE` is set as an env var prefix so the same script can distinguish Pre vs Post invocation.

## Hook Input/Output Protocol

### Input (stdin)

```json
{
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/path/to/file.ts",
    "old_string": "...",
    "new_string": "..."
  },
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript"
}
```

### Output (exit codes)

| Exit Code | Meaning |
|---|---|
| 0 | Allow tool use (no message) |
| 0 + stdout | Allow, show message to user |
| 2 | Block tool use (stdout = block reason) |

## Master Enforcement Hook

**File:** `scripts/workflows/lib/hooks/enforce-step-workflow.js`

This is the primary enforcement hook, handling both PreToolUse and PostToolUse for all workflows.

### PreToolUse Rules

**Rule 1 — Step gating:** Block tool commands unless the matching workflow step is `in_progress`.

Example: If the current step is `brief`, attempting to run a `commit` command is blocked.

**Rule 2 — Transition gating:** Block step transitions unless the step's expected command has been executed.

Example: Cannot transition `brief → spec` unless `brief.md` was actually generated.

**Rule 3 — State protection:** Block direct edits to state files (`.work-state.json`, etc.).

**Rule 4 — Artifact protection:** Block writes to step artifacts by unauthorized agents.

**Rule 5 — Agent-gated scripts:** Verify the calling agent is authorized for specific scripts (e.g., only `developer-*` agents can call `tdd-phase-state.js`).

### PostToolUse Rules

**Evidence recording:** After a tool executes, record what happened in `.step-evidence.json`.

**Evidence clearing:** On backward transitions, clear evidence for all steps between the target and current.

### Policy Decomposition (GH-206)

Enforcement logic is decomposed into pure decision functions:

| Policy Module | Responsibility |
|---|---|
| `command-matching.js` | Match tool call to workflow step |
| `agent-authorization.js` | Verify agent identity and permissions |
| `state-protection.js` | Protect state file writes |
| `evidence-recorder.js` | Load/save/clear evidence |
| `step-gate.js` | Decide if step command should be allowed |
| `transition-gate.js` | Decide if transition should be allowed |

## Fail-Open Policy

All hooks follow a strict fail-open policy:

1. If any error occurs inside the hook → exit 0 (allow)
2. Errors are logged to `hook-error-log.js` (file-based, not stderr)
3. Only intentional blocks use exit 2
4. `didBlock` flag preserves block decisions even during cleanup errors

**Rationale:** A hook crash should never prevent the user from working. False negatives (allowing when should block) are preferable to false positives (blocking valid work).

## Workflow-Specific Hooks

### /work hooks (`scripts/workflows/work/hooks/`)

| Hook | Purpose |
|---|---|
| `enforce-coverage-fix.js` | Post-check coverage improvement |
| `work-require-implement.js` | Block code changes outside implement step |
| `work-code-review-status.js` | Track code review consensus |

### /work-implement hooks (`scripts/workflows/work-implement/hooks/`)

| Hook | Purpose |
|---|---|
| `work-implement-enforce.js` | TDD phase file gating (RED/GREEN/REFACTOR) |

### /check2 hooks (`scripts/workflows/check/hooks/`)

| Hook | Purpose |
|---|---|
| `check-setup.js` | Initialize check context, discover impacted apps |
| `check-start-env.js` | Start dev servers |
| `check-validate-reports.js` | Validate report format and status lines |

### Shared hooks consumed by /check2 (`scripts/workflows/lib/hooks/`)

| Hook | Purpose |
|---|---|
| `enforce-screenshot-requirement.js` | Block QA without screenshots (GH-207) |

## Session Guard

**File:** `scripts/workflows/lib/hooks/session-guard.js`

Prevents concurrent `/work` sessions:
- Creates a lock file on workflow start
- Blocks if lock exists from another session
- Cleans up on PreCompact/Stop events
- Controlled by `SESSION_GUARD_ENABLED` env var

## Error Logging

**File:** `scripts/workflows/lib/hook-error-log.js`

Hook errors go to a log file instead of stderr:
- Path: `/tmp/claude-hook-errors.log` (or `HOOK_ERROR_LOG` env)
- Auto-rotation at 1MB
- Format: `[timestamp] [pid] [context] message`
- Verbose stderr: Set `ENFORCE_HOOK_DEBUG=1`

## Debugging Hooks

```bash
# Enable verbose hook logging
export ENFORCE_HOOK_DEBUG=1

# View hook error log
cat /tmp/claude-hook-errors.log

# Skip TDD token verification (standalone testing)
export WORK_TDD_TOKEN_SKIP=1

# Disable session guard
export SESSION_GUARD_ENABLED=0
```

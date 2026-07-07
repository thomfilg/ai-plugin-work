# Hook System

The enforcement system uses Claude Code hooks (PreToolUse, PostToolUse, PreCompact, Stop, SubagentStop) to gate tool usage, record evidence, and protect state files.

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
          { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/hooks/protect-tasks-md.js" },
          { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/hooks/protect-task-scope.js" },
          { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work-implement/hooks/work-implement-enforce.js" }
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
    ],
    "SubagentStop": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work-implement/hooks/enforce-tdd-on-stop.js", "timeout": 30 }
        ]
      }
    ]
  }
}
```

Note: This is a simplified excerpt. The full `hooks.json` includes additional matchers for `Bash`, MCP tools, `AskUserQuestion`, `PreCompact`, and `Stop` events, plus the remaining protect-* hooks (`protect-gherkin.js`, `protect-orchestrator-state.js`) on the write matchers. `CLAUDE_HOOK_TYPE` is set as an env var prefix so the same script can distinguish Pre vs Post invocation. `work-implement-enforce.js` runs AFTER the protect-* hooks; `enforce-tdd-on-stop.js` matches every subagent stop and self-filters (exit 0) for non-developer agents and non-implement contexts.

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
| `work-code-review-status.js` | Track code review consensus |
| `protect-tasks-md.js` | Block edits to planner-owned tasks.md outside the tasks phase |
| `protect-task-scope.js` | Block edits outside the active task's `### Files in scope` |
| `work-require-implement.js` | Block code changes outside implement step (hook script exists and consumes `preflight.js`, but is NOT currently registered in hooks.json) |

### /work-implement hooks (`scripts/workflows/work-implement/hooks/`)

| Hook | Event / Matcher | Purpose |
|---|---|---|
| `work-implement-enforce.js` | PreToolUse, `Edit\|Write\|MultiEdit` (after protect-*) | TDD phase file gating (RED/GREEN/REFACTOR) |
| `enforce-tdd-on-stop.js` | SubagentStop, `.*` (self-filtering) | Block developer agents from stopping during `implement` without a valid TDD cycle; prints the `task-next.js` command, never records evidence itself |

### /check hooks (`scripts/workflows/check/hooks/`)

| Hook | Purpose |
|---|---|
| `check-setup.js` | Initialize check context, discover impacted apps |
| `check-start-env.js` | Start dev servers |
| `check-validate-reports.js` | Validate report format and status lines |

### Shared hooks consumed by /check (`scripts/workflows/lib/hooks/`)

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

## Dual runtime: the same hooks.json on Codex CLI

One `hooks/hooks.json` serves both runtimes (kept in the intersection both parsers accept by
`scripts/lint-hooks-json.js`). Every hook script detects its runtime via the vendored
`lib/runtime` detector (`AGENT_RUNTIME` pin → payload sniff → codex env signatures → session
stamp → Claude signals → default `claude`) and adapts. What differs on codex:

### Matcher lanes

Codex only ever emits its own tool names, so some lanes can never fire there:

| Matcher lane | claude | codex |
|---|---|---|
| `Bash` | fires | fires (codex reads files via shell too — this lane covers the Read/Grep/Glob loss) |
| `Edit\|Write\|MultiEdit` | fires | `Write`/`Edit` alias-fire for `apply_patch`; `MultiEdit` dead |
| `Task\|Skill\|Agent` | `Task`/`Skill` fire | only `Agent` fires (spawn-agent events) |
| `AskUserQuestion\|request_user_input` | `AskUserQuestion` fires | only `request_user_input` fires — and only in Plan mode (openai/codex#10384); in code mode the model asks in chat, so this lane is rarely exercised |
| `Read\|Grep\|Glob`, `MultiEdit`, `NotebookEdit`, `Skill`, `Monitor` | fire | dead — accepted loss, Bash/UPS lanes carry enforcement |
| `UserPromptSubmit` / `Stop` matchers | applied by Claude | **ignored** — the hooks fire on every prompt/stop and re-apply their matcher in-script |

Run `node scripts/runtime-doctor.js` (repo root) for the live per-plugin lane table.

### Payload and emission differences

- **Payload-first reads**: `CLAUDE_USER_PROMPT`, `TOOL_INPUT`, `CLAUDE_PROJECT_DIR` etc. are
  never set by codex — every script reads the stdin payload first (`prompt`, `tool_input`,
  `cwd`, `session_id`), env as legacy fallback.
- **`tool_input.file_path` is absent** on codex writes — `apply_patch` carries a raw patch;
  write targets are parsed from the `*** Add/Update/Delete File:` headers. Parse failure on a
  write tool fails **closed** for protectors with active locks.
- **Auto-advance channel**: plain PostToolUse stdout is not injected by codex — the drivetrain
  banner rides `hookSpecificOutput.additionalContext` instead (identical text).
- **Exit-2 stderr** and UserPromptSubmit/SessionStart plain stdout behave the same on both.

### Trust model (codex only — READ THIS)

Codex **silently skips untrusted hooks**: after install or ANY hooks.json change, every gate in
this document is OFF until the hooks are re-trusted in the codex TUI `/hooks` review (one-time
per change; changes are batched per release). The TUI also prompts **proactively at session
start** (live-verified on 0.142.5, GT §11.2) — the exact pane text to look for:

> Hooks need review
> 59 hooks are new or changed.
> Hooks can run outside the sandbox after you trust them.
> 1. Review hooks / 2. Trust all and continue / 3. Continue without trusting (hooks won't run)

The review table says "Press t to trust all; enter to review hooks; esc to close"; each hook
detail shows Event/Matcher/Source/Command/Timeout plus "New hook - review required. Press t
to trust; esc to go back". Unattended runs use
`codex exec --dangerously-bypass-hook-trust` per invocation. Never script `[hooks.state]`
`trusted_hash` writes — the hash formula is source-derived, not bit-exact-verified, and
pre-seeding trust is a gate-bypass. Audit with `node scripts/runtime-doctor.js` (its
"modified" verdicts are best-effort for the same reason).

### Interactive gates in `codex exec`

Unattended exec has no question UI: gates that would call `AskUserQuestion` park the step
BLOCKED and persist a hold file. Answer via the maestro `/signal` inbox or the resume-answer
channel, **live-verified on 0.142.5** (WP-12, design §0 C3 RESOLVED):

```
codex exec resume <SESSION_ID> --json --dangerously-bypass-hook-trust \
  -c 'sandbox_mode="workspace-write"' '<answer>'
```

- `Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` — the answer is a positional
  argument (`-` reads stdin); the resumed turn re-fires SessionStart/UserPromptSubmit/Stop
  hooks, so a heimdall unlock phrase sent this way lands in the rollout transcript.
- `--last` also works but is **cwd-filtered** (it picks the newest session recorded for the
  invoking directory, not globally) — run it from the agent's worktree or pass the id.
- `exec resume` REJECTS `-s`/`-C` (narrower flag surface than `exec`) — set the sandbox via
  `-c sandbox_mode=…`; `--json`/`-o`/`--skip-git-repo-check`/both bypass flags are accepted.

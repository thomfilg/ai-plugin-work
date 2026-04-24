---
name: work-implement
description: Quick implementation without the full /work workflow
argument-hint: <description of what to implement>
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite
---

# Implement Command

Quick implementation without the full /work workflow. Use when you already have a branch set up and just need to implement changes.

## Usage

```
/work-implement <description of what to implement>
/work-implement --subtask <TICKET_ID> <description>
```

**Examples:**
- `/work-implement add email categorization for CD notifications`
- `/work-implement fix the weekend activities loading bug`
- `/work-implement create a new Button variant with loading state`
- `/work-implement --subtask GH-83 fix(ci): resolve lint error in src/utils.js`

## Instructions

### Step 0: Setup task folder

```bash
# Determine task ID (from branch name or Jira ticket)
BRANCH=$(git branch --show-current)
TICKET_ID=$(echo "$BRANCH" | grep -oE '[A-Z]+-[0-9]+' || echo "task-$(date +%Y%m%d-%H%M%S)")
TASK_DIR="$HOME/worktrees/tasks/${TICKET_ID}"

# Create task folder
mkdir -p "$TASK_DIR"
```

**Parse --subtask flag (if present):**

If the arguments contain `--subtask <TICKET_ID>`, this is a subtask invocation from `/follow-up-pr`:

```bash
# Parse --subtask flag (portable — no grep -P dependency)
SUBTASK_PARENT=""
case "$ARGS" in
  *--subtask*)
    SUBTASK_PARENT=$(echo "$ARGS" | sed -n 's/.*--subtask[[:space:]]\+\([^[:space:]]\+\).*/\1/p')
    DESCRIPTION=$(echo "$ARGS" | sed 's/--subtask[[:space:]]\+[^[:space:]]\+//')
    ;;
esac
```

When `--subtask` is present:
- Use `SUBTASK_PARENT` as the ticket ID (skip branch/worktree detection)
- Initialize subtask state: `node ${CLAUDE_PLUGIN_ROOT}/workflows/work/work-state.js init-subtask <TICKET_ID> "<description>"`
- Skip `implement.md` creation (subtask state file replaces it)
- The subtask state tracks only two steps: `implement`, `commit`

When `--subtask` is NOT present, proceed normally:

**Save implementation tracking file:**
```markdown
# $HOME/worktrees/tasks/${TICKET_ID}/implement.md

## Implementation: <description>
Date: <timestamp>
Branch: <branch-name>

### Request
<original request>

### Agent Used
<developer-agent-name>

### Changes
<to be filled after implementation>
```

### Step 1: Analyze the request

1. **Understand the scope:**
   - What needs to be implemented?
   - Which files/areas are affected?
   - Is this frontend, backend, or both?

2. **Search for context:**
   ```bash
   # Find related files
   git grep "related_term"
   ```

3. **Check for existing patterns:**
   - Look for similar implementations in the codebase
   - Follow established conventions

4. **Check for task plan:**
   - Look for `${TASKS_BASE}/${TICKET_ID}/tasks.md`
   - If it exists and your prompt specifies a task (e.g., "Task 3 — ..."), use it as the implementation roadmap
   - Implement ONLY the deliverables listed in the specified task
   - Reference the `_Requirements:_` annotations to ensure nothing is missed
   - After completing each deliverable, verify its `Test:` acceptance criterion is met

### Step 2: Plan with TodoWrite

If `tasks.md` exists and a specific task is referenced in your prompt, derive TodoWrite items directly from that task's deliverables instead of creating a plan from scratch. This ensures the implementation follows the pre-planned decomposition.

Otherwise, break the implementation into 3-7 subtasks:

```
TodoWrite([
  { content: "Research existing patterns", status: "pending", activeForm: "Researching existing patterns" },
  { content: "Implement core logic", status: "pending", activeForm: "Implementing core logic" },
  { content: "Add tests", status: "pending", activeForm: "Adding tests" },
  { content: "Run quality checks", status: "pending", activeForm: "Running quality checks" }
])
```

### Step 2.5: TDD Phase Loop (Hook-Enforced)

The TDD loop is enforced by hooks — not by agent discipline. File restrictions are automatic per phase.

**Initialize TDD state:**
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js init <TICKET_ID>
```

**For each behavior change, cycle through RED → GREEN → REFACTOR:**

#### RED Phase (write failing tests)
- The hook BLOCKS Write/Edit to any non `.test`/`.spec` file
- Write focused tests that express the expected behavior (1-3 tests)
- When done, record evidence and transition:
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js record-red <TICKET_ID> --cmd "<targeted test command>"
# Script runs git diff to find changed test files
# Script runs the test command — tests MUST FAIL (exit non-zero)
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js transition <TICKET_ID> green
```

#### GREEN Phase (make tests pass)
- The hook BLOCKS Write/Edit to `.test`/`.spec` files (prevents cheating)
- Test helpers are allowed: `__mocks__/`, `__fixtures__/`, `test-utils`, `*.mock.*`, `*.fixture.*`
- Write minimum production code to make the failing tests pass
- When done, record evidence and transition:
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js record-green <TICKET_ID> --cmd "<same test command>"
# Script runs the test command — tests MUST PASS (exit zero)
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js transition <TICKET_ID> refactor
```

#### REFACTOR Phase (clean up)
- No file restrictions — touch any files
- Refactor both test and production code for clarity
- When done, record evidence and transition back to RED (or proceed to Step 3):
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js record-refactor <TICKET_ID> --cmd "<broader test command>"
# Script runs the test command — tests MUST still PASS
# If more behaviors to implement:
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js transition <TICKET_ID> red
# If done with all behaviors: proceed to Step 3
```

**REFACTOR is developer-owned self-cleanup only.** `/tests-review` and `/code-review` are NOT run during REFACTOR — they run as a separate post-commit gate via `workflows/work/steps/task-review.js` (GH-211). The developer agent's responsibility in REFACTOR ends at producing clean, still-green code; reviewer agents take over afterwards against the committed diff.

**REFACTOR exit checklist (advisory):**
- tests still green
- no dead code
- naming consistent

_Why this split?_ Reviews run as a different agent against a committed artifact, which keeps the core workflow aligned to the three-phase TDD loop (RED/GREEN/REFACTOR) and ensures reviewers never see half-refactored work. See `workflows/work/steps/task-review.js` (GH-211) for the post-commit review gate.

**Important:**
- Evidence is recorded by the SCRIPT, not by agents — the script runs `git diff` and test commands itself
- Do NOT make local git commits during the TDD loop — the commit step handles that
**Exception mode** (for non-testable changes only):
If the change is purely mechanical, use the exception command with a required category:
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js exception <TICKET_ID> --category <category> --reason "<reason>"
```

Allowed categories: `checkpoint`, `config-only`, `file-move`, `mechanical-refactor`

**What does NOT qualify for exception mode:**
- New components, hooks, or providers
- New types with behavior (throw guards, validators)
- New utility functions with logic
- Any code the spec lists test scenarios for
- New files with exports (heuristic will block)

### Step 3: Select and invoke the appropriate agent

```
╔══════════════════════════════════════════════════════════════════════╗
║  🔧 MANDATORY: You MUST invoke a developer agent                     ║
║                                                                      ║
║  Direct Write/Edit is blocked - use Task() to delegate               ║
╚══════════════════════════════════════════════════════════════════════╝
```

Based on the implementation type:

| Implementation Type | Agent to Use |
|---------------------|--------------|
| Node.js/Express/NestJS backend | `developer-nodejs-tdd` |
| React components with complex logic | `developer-react-senior` |
| React UI with visual design focus | `developer-react-ui-architect` |
| Infrastructure/DevOps | `developer-devops` |
| Architecture-first / complex design | `code-architect` (requires `WORK_ARCHITECT_ENABLED=1`) |

**Invoke the agent:**

```
Task(<agent-name>):
  Implement: <description>

  Context:
  - Current branch: <branch-name>
  - Affected areas: <list affected files/modules>
  - Requirements: <specific requirements>

  Constraints:
  - Follow existing code patterns
  - Keep changes focused on the request
  - TDD is enforced by hooks:
    - RED phase: only test files can be modified
    - GREEN phase: only production code can be modified
    - REFACTOR phase: no restrictions
    - Use tdd-phase-state.js CLI for evidence recording and phase transitions
  - Add appropriate tests
```

### Step 4: Run targeted tests first, then broader quality checks

After agent completes:

1. Verify TDD phase evidence exists:
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work-implement/tdd-phase-state.js current <TICKET_ID>
# Should show the current phase and cycle count
```

2. Then run broader checks:
```bash
pnpm dev:check   # Runs: dev:lint → dev:typecheck → dev:test
```

Fix any issues before completing.

### Step 5: Update task file and report completion

**When in subtask mode (`--subtask` was set):**

1. Commit changes using commit-writer agent (subtasks commit before returning, unlike normal mode)
2. Mark subtask as completed: `node ${CLAUDE_PLUGIN_ROOT}/workflows/work/work-state.js complete-subtask <TICKET_ID> <N>`
   (where `<N>` is the subtask index from the init-subtask output)
3. Report completion briefly and return control to the parent workflow

**When called from `/work` orchestrator (orchestrator plan exists with subsequent steps):**

Still update `$HOME/worktrees/tasks/${TICKET_ID}/implement.md` with results (same as normal mode).

Then return a brief completion signal and hand control back to the orchestrator. Do NOT prompt the user for next steps or display a "Next steps" list.

```
IMPLEMENT_COMPLETE

Agent used: <agent-name>
Changes: <brief summary>
Files modified: <count> files
Quality: <quality checks run and results>
```

**When in normal mode (standalone invocation, no `--subtask`, not called from `/work`):**

**Update the implementation tracking file:**
```bash
# Update $HOME/worktrees/tasks/${TICKET_ID}/implement.md with results
```

Add the following to the `### Changes` section:
- Files modified with brief descriptions
- Agent used and summary of work done
- Quality check results

**Report to user:**
```
Implementation Complete

Task folder: $HOME/worktrees/tasks/${TICKET_ID}/
Report: implement.md

Agent used: <agent-name>

Changes made:
- <list of changes>

Files modified:
- <list of files>

Quality checks:
- Lint: PASS
- TypeCheck: PASS
- Tests: PASS (if applicable)

Next steps:
- Review the changes: git diff
- Commit when ready: use commit-writer agent
```
## Enforcement Infrastructure (GH-219)

- **Task Claims**: `claimTask(ticketId, taskNum, ownerId)` / `releaseTask(...)` acquire atomic lock files at `TASKS_BASE/<ticketId>/.claims/task-${n}.lock`. Owner IDs use `PR{N}` format (e.g., PR1, PR42). Module: `workflows/work/work-claims.js`.

- **PR{N} Worker Layout**: Parallel workers get assigned slots via `allocateWorkerSlot()`. Output goes to `TASKS_BASE/<ticketId>/PR{N}/`. Slot allocation is sequential and monotonic (no reuse). Module: `workflows/work/work-state/parallel-workers.js`.

- **Per-Task Artifacts**: TDD phase state, `implement.md`, and check reports resolve to `task${N}/` subdirectories under the ticket folder. Legacy flat layout is still supported as fallback. Module: `workflows/work/work-state.js`.

- **Preflight Gate**: `runPreflight(context, options)` evaluates enforcement rules before file writes. Returns `{ allow, reasons, remediation }`. Hooks call this instead of transcript-based detection. Module: `workflows/lib/preflight.js`.

- **Enforcement Audit**: Decisions are logged to `.work-actions.json` via `appendEnforcementAudit()`. Records use `kind: 'enforcement'` discriminator (coexists with legacy step rows). Module: `workflows/work/work-actions.js`.

- **Out-of-Flow Routing**: User requests go to `user-request-${n}/`, AI subtask requests to `ai-request-${n}/`. Atomic counter in `.request-index.json`. Modules: `workflows/lib/allocate-output-folder.js`, `workflows/lib/request-index.js`.

- **P2 Deferred Features**: Task/phase/readiness status summary (R21) and dry-run preflight (R22) are deferred to v2. No configurable rule registry in v1 -- rules live in `preflight.js` as explicit code.


## Notes

- This command does NOT create commits - use `commit-writer` agent after reviewing
  - **Exception:** In `--subtask` mode, the subtask commits before returning
- This command does NOT run /check - use `/check` separately if needed
- This command does NOT create PRs - use `/work` for full workflow
- For complex multi-step features, consider using `/work` instead
- **Agent delegation is MANDATORY** - direct Write/Edit is blocked
- **Subtask mode** (`--subtask <TICKET_ID>`): Skips branch/worktree creation, uses subtask state tracking, commits on completion, and returns control to parent workflow
- **Orchestrator mode**: When invoked by `/work`, returns a brief completion signal instead of prompting the user — the orchestrator handles subsequent steps (commit, check, PR)

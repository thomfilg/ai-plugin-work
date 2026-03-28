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
- Initialize subtask state: `node ${CLAUDE_PLUGIN_ROOT}/hooks/work-state.js init-subtask <TICKET_ID> "<description>"`
- Skip `implement.md` creation (subtask state file replaces it)
- The subtask state tracks only three steps: `implement`, `quality`, `commit`

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

### Step 2: Plan with TodoWrite

Break the implementation into 3-7 subtasks:

```
TodoWrite([
  { content: "Research existing patterns", status: "pending", activeForm: "Researching existing patterns" },
  { content: "Implement core logic", status: "pending", activeForm: "Implementing core logic" },
  { content: "Add tests", status: "pending", activeForm: "Adding tests" },
  { content: "Run quality checks", status: "pending", activeForm: "Running quality checks" }
])
```

### Step 2.5: Mandatory TDD Loop

Before changing production code:

1. Locate the closest existing test file for the affected behavior
2. Add or update the smallest focused test set that expresses the expected behavior (usually 1-3 tests)
3. Run the smallest relevant test command and confirm the new test fails (RED)
4. Implement the minimum production change required
5. Re-run the same targeted test command and confirm it passes (GREEN)
6. Refactor only after the targeted test is green
7. Record evidence via CLI:
   `node <ORCHESTRATOR_PATH> record-tdd <TICKET_ID> 5_implement --cmd "<test command>" --red --green --files "<test files>"`
   `<ORCHESTRATOR_PATH>` and `<TICKET_ID>` are provided by the `/work` orchestrator in the
   delegated prompt context. When running `/work-implement` standalone (outside `/work`),
   use the concrete path: `node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js` and the
   ticket ID from the current branch (`git branch --show-current | grep -oE '[A-Z]+-[0-9]+'`).
8. Record the RED and GREEN evidence in `implement.md`

Important: Do NOT make local git commits during the TDD loop. Leave all changes (test files
and production code) uncommitted. The commit step (`7_commit`) handles commits with proper
message formatting and squashing.

If the change is mechanical or not meaningfully behavior-testable:
- Record exception via CLI:
  `node <ORCHESTRATOR_PATH> record-tdd <TICKET_ID> 5_implement --exception "<reason>"`
  (Same path resolution as above.)
- Add or update the closest relevant tests where possible
- Continue with the smallest safe change

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
  - Use TDD by default:
    - Write focused failing tests first when behavior is testable
    - Run targeted tests and confirm RED
    - Implement the minimum fix
    - Rerun targeted tests and confirm GREEN
    - Record TDD evidence via `record-tdd` CLI before completing
    - Refactor after GREEN
  - Add appropriate tests
```

### Step 4: Run targeted tests first, then broader quality checks

After agent completes:

1. Re-run the exact targeted tests used in the RED/GREEN loop
2. Then run broader checks:

```bash
# Quick checks on changed files only (preferred during development)
pnpm dev:check   # Runs: dev:lint → dev:typecheck → dev:test

# Or run individually:
pnpm dev:lint      # Lint only changed JS/TS files
pnpm dev:typecheck # Typecheck only changed TS files
pnpm dev:test      # Unit tests for changed files (excludes smoke/e2e)
```

Fix any issues before completing.

### Step 5: Update task file and report completion

**When in subtask mode (`--subtask` was set):**

1. Commit changes using commit-writer agent (subtasks commit before returning, unlike normal mode)
2. Mark subtask as completed: `node ${CLAUDE_PLUGIN_ROOT}/hooks/work-state.js complete-subtask <TICKET_ID> <N>`
   (where `<N>` is the subtask index from the init-subtask output)
3. Report completion briefly and return control to the parent workflow

**When called from `/work` orchestrator (orchestrator plan exists with subsequent steps):**

Still update `$HOME/worktrees/tasks/${TICKET_ID}/implement.md` with results (same as normal mode) and record TDD evidence.

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

## Notes

- This command does NOT create commits - use `commit-writer` agent after reviewing
  - **Exception:** In `--subtask` mode, the subtask commits before returning
- This command does NOT run /check - use `/check` separately if needed
- This command does NOT create PRs - use `/work` for full workflow
- For complex multi-step features, consider using `/work` instead
- **Agent delegation is MANDATORY** - direct Write/Edit is blocked
- **Subtask mode** (`--subtask <TICKET_ID>`): Skips branch/worktree creation, uses subtask state tracking, commits on completion, and returns control to parent workflow
- **Orchestrator mode**: When invoked by `/work`, returns a brief completion signal instead of prompting the user — the orchestrator handles subsequent steps (commit, check, PR)

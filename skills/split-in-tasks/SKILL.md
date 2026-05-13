---
name: split-in-tasks
description: Split a spec into small, ordered, deliverable tasks with requirement traceability
argument-hint: <TICKET_ID or folder name> [--force]
user-invocable: true
allowed-tools: Task, Bash, Read, Grep, Glob
---

# /split-in-tasks — Spec Decomposition into Implementation Tasks

Split a technical specification into small, ordered, dependency-aware tasks. Each task is tied back to specific requirements so the implementing agent never loses track of what needs to be built.

## Usage

```
/split-in-tasks PROJ-123              # Split spec for ticket
/split-in-tasks "add-user-dashboard"  # Split spec from a named folder
/split-in-tasks                       # Auto-detect from current branch
/split-in-tasks PROJ-123 --force      # Overwrite existing tasks.md without prompting
```

---

## Execution

### Step 1: Determine ticket and tasks folder

Resolve the tasks folder:

1. If an argument is provided and looks like a ticket ID (e.g., `PROJ-123`, `#42`): sanitize it for use as folder name (e.g., `#42` → `GH-42`) to match how other workflow commands resolve task paths
2. If an argument is provided and is a slug/folder name: use directly
3. If no argument: detect from current branch — `git branch --show-current | grep -oE '[A-Z]+-[0-9]+'`
4. If detection fails: stop with error — "Could not determine ticket ID. Provide one as argument."

Resolve the tasks base directory using the workflow config module (same as `/brief` and `/spec`):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
node -e "const c = require('$PLUGIN_ROOT/scripts/workflows/lib/config'); console.log(JSON.stringify({ TASKS_BASE: c.TASKS_BASE }))"
```

Set `TASKS_DIR="${TASKS_BASE}/${FOLDER_NAME}"`.

### Step 2: Read input documents

Read files from `${TASKS_DIR}/`:

1. **`brief.md`** (required) — Contains the requirements, user stories, and acceptance criteria
2. **`spec.md`** (required) — Contains the technical specification, architecture, and implementation details
3. **`gherkin.feature`** (optional) — Contains the gherkin test scenarios. If present, each task must reference which scenario(s) it covers.

**If `brief.md` is missing:** Stop with error: "No brief.md found at `${TASKS_DIR}/brief.md`. Run `/brief ${FOLDER_NAME}` first."

**If `spec.md` is missing:** Stop with error: "No spec.md found at `${TASKS_DIR}/spec.md`. Run `/spec ${FOLDER_NAME}` first."

### Step 3: Check for existing tasks

If `${TASKS_DIR}/tasks.md` already exists:
- If `--force` flag was passed: proceed (overwrite silently)
- Otherwise: ask the user "tasks.md already exists. Overwrite? (y/n)". Stop if user declines.

### Step 4: Generate tasks

You are the decomposer. Read both `brief.md` and `spec.md` in full, then follow steps 4.0 through 4.3 in order.

#### Step 4.0 — Extract Requirements (MANDATORY — do this BEFORE creating any tasks)

Before creating any tasks:

1. Read through the entire brief.md and spec.md
2. Extract ALL requirements into a numbered list
3. Assign each requirement a stable ID:
   - Use spec/brief numbering if available (e.g., "spec §2.1", "brief AC-3")
   - If no numbering exists, assign sequential IDs: R1, R2, R3...
4. Include ALL of:
   - Functional requirements
   - Non-functional requirements (performance, security, etc.)
   - Constraints (tech stack, naming conventions, env vars, etc.)
   - Integration requirements (APIs, external services, etc.)
5. Apply granularity control:
   - If a requirement is too large (maps to 3+ tasks on its own), split it into sub-requirements: R1a, R1b, R1c
   - If a requirement is too trivial (less than a single subtask of work), merge it with a related requirement
   - Goal: each requirement should map cleanly to 1–2 tasks

This list is the **source of truth** for requirement coverage. Every task you create MUST reference IDs from this list. Keep this list in working memory — you will need it for coverage validation in Step 4.3.

#### Step 4.1 — Decompose into tasks

Using the extracted requirement list as your guide, decompose the spec into tasks following ALL of these rules:

**Rule 1 — Atomicity:**
Each task must modify ONE logical component (e.g., one service, one UI module, one infrastructure unit) and produce ONE verifiable outcome (e.g., an API endpoint works, an agent classifies correctly, a DB table is created). If a task spans multiple components or produces multiple unrelated outcomes, split it.

**Rule 2 — Requirement Coverage:**
Every requirement from your Step 4.0 list must appear in at least one task's `Requirements Covered` section. Orphan requirements (in spec but not in any task) and orphan tasks (no requirement mapping) must be resolved in Step 4.3 before proceeding — add missing mappings or create/merge tasks until coverage is complete.

**Rule 3 — Independent Testability:**
Every task must be testable in isolation. If you can't write a test for it, it's not a task — it's part of another task.

**Rule 4 — No Overlap:**
No two tasks should deliver the same code or satisfy the same requirement. If a requirement needs work across multiple tasks, split the requirement's concerns explicitly so each task owns a distinct piece.

**Rule 5 — Logical Ordering:**
Tasks are ordered by dependency. Foundational/infrastructure tasks first, then core logic, then integration/UI, then validation/checkpoints.

**Rule 6 — Separation Preference:**
Prefer separating: backend vs frontend, infrastructure vs application logic, data layer vs business logic, core vs integration. Clear ownership boundaries per task.

**Rule 7 — Task Count:**
Target 5–15 tasks for a typical spec. Fewer than 5 means tasks are too coarse (agent will forget mid-task). More than 15 means tasks are too granular (overhead exceeds value).

**Rule 8 — Checkpoints:**
Insert a checkpoint task (no implementation — just "run all tests, verify integration"):
- After every 3 implementation tasks, OR
- After completing a logical subsystem (e.g., all backend tasks done, all infra tasks done)
Whichever comes first.

**Rule 9 — Parallelization:**
A task can be marked `Parallel: Yes` ONLY if ALL of these are true:
- It has zero dependencies on incomplete tasks
- It does not modify the same files or components as any concurrent task
- It does not require outputs (code, config, data) from any incomplete task
Otherwise mark `Parallel: No` or `Parallel: Partial` with explanation.

**Rule 10 — TDD Ordering:**
Standard implementation tasks MUST order deliverables following the TDD cycle: RED (write failing tests) -> GREEN (implement to pass) -> REFACTOR (clean up). Each deliverable gets a bold phase prefix: `**RED:**`, `**GREEN:**`, `**REFACTOR:**`. When a task covers multiple behaviors, each behavior gets its own RED/GREEN/REFACTOR triplet.

Checkpoint tasks and config-only infrastructure tasks are exempt from the RED/GREEN/REFACTOR deliverables requirement. For those exempt tasks, use a non-phase deliverables list that describes the concrete verifiable work in execution order, for example: `- Update config`, `- Validate config`, `- Document rollout/usage` as applicable.

**Rule 12 — Shared-Resource Detection (MANDATORY for parallel tasks):**
After marking tasks as `Parallel: Yes`, scan ALL parallel tasks' Suggested Scope for **overlapping production files**. If two or more parallel tasks modify the **same production file** (not test files — those don't conflict):
1. Extract the shared changes into a new **prerequisite task** that makes the shared modifications first
2. **Reorder all tasks** — the prerequisite becomes the first task (Task 1), and all subsequent tasks renumber accordingly. Never use "Task 0" — all tasks are numbered sequentially starting from 1.
3. Mark the prerequisite as `Parallel: No` with dependency `None`
4. Update all tasks that originally touched the shared file to depend on the prerequisite
5. The prerequisite task should ONLY make the shared changes (e.g., "add data-testid to BulkActionsDropdown"), not implement the full feature
6. Add a `## Parallelization Plan` section at the top of the file showing Wave 1 (prerequisite) → Wave 2 (parallel) → Wave 3 (checkpoints) structure

Example: If Task 3 and Task 5 both need to modify `BulkActionsDropdown.tsx`, create a new task for the shared changes, make it Task 1, renumber everything else, and mark the parallel tasks as depending on it.

**Anti-patterns — DO NOT generate tasks like these:**
- "Implement backend logic" (too vague, spans multiple components)
- "Setup everything" (not atomic, no single verifiable outcome)
- Tasks spanning multiple layers (backend + frontend + infra in one task)
- Tasks without acceptance criteria
- Tasks without requirement mapping
- "Refactor and clean up" as a standalone task (cleanup belongs inside the task that creates the code)

**Anti-patterns are enforced by `scripts/workflows/lib/hooks/policies/task-description-quality.js` — the canonical blocked-pattern list. The following patterns will cause `tasks.md` writes to be blocked:**
- **TBD** — Replace the TBD placeholder with a concrete description of what this task delivers.
- **TODO** — Replace the TODO placeholder with specific implementation details.
- **implement later** — Remove the deferral phrase and describe what should be implemented now, or move to a separate task. (Blocked unless followed by 20+ chars of qualifying detail.)
- **to be determined** — Replace with a concrete decision or escalate to the spec phase. (Always blocked, no qualification possible.)
- **Handle edge cases** — Specify which edge cases to handle (e.g. null input, empty array, overflow). (Blocked unless followed by 20+ chars of qualifying detail.)
- **Add appropriate error handling** — Specify which error types to handle and the handling strategy (retry, fallback, abort). (Blocked unless followed by 20+ chars of qualifying detail.)
- **Add tests** — List specific test scenarios (e.g. "test that invalid input returns 400"). (Blocked unless followed by 20+ chars of qualifying detail. Lines with TDD phase prefixes like `**RED:**` are exempt.)
- **Similar/Same as Task N** — Repeat the actual steps instead of cross-referencing another task.


#### Step 4.2 — Gherkin Coverage Validation (when gherkin.feature exists)

If `${TASKS_DIR}/gherkin.feature` exists:
1. Parse gherkin scenarios from the file
2. For each scenario, verify it is referenced by name in at least one task
3. If any scenario is not covered, add it to an existing task or create a new task
4. Include a Gherkin Coverage table in the output (similar to Requirement Coverage)

#### Step 4.3 — Requirement Coverage Validation (MANDATORY — do this AFTER creating all tasks)

After generating all tasks, verify coverage:

1. Take your requirement list from Step 4.0
2. For each requirement, confirm it appears in at least one task's `Requirements Covered` section
3. If any requirement is missing: add it to an existing task or create a new task
4. Generate the `Requirement Coverage` table (see output format below)

### Step 5: Quality review pass (MANDATORY — do this BEFORE saving)

Review all generated tasks and check:

- No task is too large (spans multiple components or outcomes)
- No task is trivial (less than ~5 minutes of work — merge it into an adjacent task)
- Dependencies are minimal (prefer independent tasks where possible)
- Parallelization is maximized safely (any task marked `No` that could be `Yes`?)
- Shared-resource detection: parallel tasks don't modify the same production files (if they do, extract a prerequisite — Rule 12)
- Checkpoint tasks are present after every 3 implementation tasks or subsystem boundary
- TDD ordering is correct (RED before GREEN before REFACTOR in every non-exempt implementation task — see Rule 10 for exemptions)
- Every non-checkpoint implementation task has a `### Test Command` with a real, runnable test command
- Gherkin coverage: every scenario from `gherkin.feature` is referenced by at least one task (if `gherkin.feature` exists)
- Anti-patterns are absent

Refactor tasks if any issues are found. Re-validate coverage after any refactoring.

### Step 6: Save output

Write the generated content to `${TASKS_DIR}/tasks.md`.

### Step 7: Summary

After saving, output:
- Confirm the file was saved and show the full path
- Show task count (implementation + checkpoint) and total subtask count
- Show requirement count and coverage status (all covered / N gaps)
- If any coverage gaps remain, list them explicitly
- Suggest next step: "Run `/work ${FOLDER_NAME}` to start implementation."

---

## Output Format

### Checkbox Legend
All deliverables start with `[ ]`. The workflow engine updates them automatically:
- `[ ]` — not started
- `[-]` — in progress (TDD initialized)
- `[x]` — implementation done (TDD evidence recorded)
- `[v]` — verified by completion-checker

### Task format (implementation tasks)

```markdown
## Task N — <title>

### Type
<infrastructure | backend | frontend | integration | test | checkpoint>

### Description
<1-3 sentence summary of what this task delivers>

### Requirements Covered
- <requirement ID from Step 4.0>
- <requirement ID from Step 4.0>

### Deliverables
- [ ] N.1 <subtask description>
  - Test: <acceptance criterion>
  - [ ] N.1.1 **RED:** Write failing tests for <behavior>
    - Test: Tests fail — <expected behavior> is not yet implemented
  - [ ] N.1.2 **GREEN:** Implement <behavior> to pass tests
    - Test: All tests from N.1.1 pass
  - [ ] N.1.3 **REFACTOR:** Refactor <component> for clarity
    - Test: All tests still pass after refactoring
  - _Requirements: <requirement ID> (<context>), <requirement ID> (<context>)_
- [ ] N.2 <subtask description>
  - Test: <acceptance criterion>
  - [ ] N.2.1 **RED:** Write failing tests for <behavior>
    - Test: Tests fail — <expected behavior> is not yet implemented
  - [ ] N.2.2 **GREEN:** Implement <behavior> to pass tests
    - Test: All tests from N.2.1 pass
  - [ ] N.2.3 **REFACTOR:** Refactor <component> for clarity
    - Test: All tests still pass after refactoring
  - _Requirements: <requirement ID> (<context>), <requirement ID> (<context>)_

### Acceptance Criteria
- <criterion 1>
- <criterion 2>

### Dependencies
- None | Task N (reason)

### Parallel
- Yes | No | Partial (reason)

### Test Command
<shell command to run tests for this task — supports && chaining for multiple test suites>

**MANDATORY format**: the command MUST use the per-suite env vars and the literal `$CHANGED_FILES` placeholder. Do NOT hardcode `pnpm test`/`pnpm e2e` paths — the project overrides the runner via `.envrc`, and the implement-gate executes whatever you write here verbatim.

Pick the env var by suite type:

| Suite | Env var |
|---|---|
| Unit / component | `$TEST_UNIT_COMMAND` |
| Integration | `$TEST_INTEGRATION_COMMAND` |
| E2E (Playwright) | `$TEST_E2E_COMMAND` |

Single-suite template (the value MUST look exactly like this — only fill in the file list and pick the matching env var):
```bash
CHANGED_FILES="<task's deliverable file paths, space-separated>" eval "$TEST_E2E_COMMAND"
```

Multi-suite template (chain with `&&`, set `$CHANGED_FILES` once for the whole chain):
```bash
CHANGED_FILES="components/admin/settings.tsx tests/e2e/specs/admin/general-settings.spec.ts" eval "$TEST_UNIT_COMMAND" && eval "$TEST_E2E_COMMAND"
```

Concrete example for an E2E task:
```bash
CHANGED_FILES="tests/e2e/specs/workbook-detail/workbook-detail-subscriptions-tab.spec.ts" eval "$TEST_E2E_COMMAND"
```

Concrete example for a unit/component task:
```bash
CHANGED_FILES="components/workbooks/workbook-views-content/workbook-subscriptions-tab-content.test.tsx" eval "$TEST_UNIT_COMMAND"
```

Hardcoded `pnpm test:foo path/to/file` is **only** allowed if a project explicitly opts out of env-var-based runners (rare — flag this with the user before falling back).

Note: The implement-gate executes this command automatically before/after dispatching the developer agent. Agents do NOT call `tdd-phase-state.js` or record any TDD evidence themselves.

### Suggested Scope (optional — include when file paths are inferable from the spec)
- `<path/to/likely/file.ts>`
- `<path/to/another/file.ts>`

### Files in scope (REQUIRED — Gate C)
- <path/or/glob/the/task/may/edit/**>
- <another/specific-file.ts>

### Files explicitly out of scope (REQUIRED — Gate C; may be empty when no siblings own related surfaces)
- <sibling-owned/file.ts — owned by [SIBLING-TICKET-ID]>

---
```

**Required sections (Gate C):**
- `### Files in scope` — Glob patterns or paths the task may edit. Must be non-empty. The implement-step hook blocks any file edit outside this set.
- `### Files explicitly out of scope` — Paths owned by sibling tickets that this task must not touch. May be empty when no siblings exist. Populate from `tasks/<ticket>/related-tickets.json` (`surfaces` array under each sibling).

The `### Suggested Scope` field is the legacy precursor — leave it in place for backwards compatibility, but ALSO emit the two new sections above.

### Task format (checkpoint tasks)

```markdown
## Task N — Checkpoint: <what to verify>

### Type
checkpoint

### Description
Verify all prior tasks are correctly implemented and integrated.

### Acceptance Criteria
- All tests pass
- <specific integration verification>

### Dependencies
- Task N-1, Task N-2, ...

---
```

### Full file structure

```markdown
# Tasks

_Generated from: brief.md, spec.md_
_Ticket: <TICKET_ID>_
_TDD Protocol: Every non-exempt implementation task follows RED -> GREEN -> REFACTOR ordering in deliverables._

## Parallelization Plan

(Include this section when any tasks are parallel. Shows wave execution order.)

**Wave 1 (prerequisite — shared resource changes):**
- Task 1: <shared changes extracted from parallel tasks>

**Wave 2 (parallel — after Wave 1):**
- Task 2, Task 3, Task 4 (all parallel, no file conflicts)

**Wave 3 (sequential — after Wave 2):**
- Task 5: Checkpoint

## Extracted Requirements

<The numbered requirement list from Step 4.0>

---

## Task 1 — ...
...

## Task N — Checkpoint: ...
...

## Requirement Coverage

| Requirement | Covered By |
|-------------|------------|
| R1          | Task 1     |
| R2          | Task 3     |
| ...         | ...        |
```

### Format rules

- Top-level tasks are numbered sequentially: Task 1, Task 2, ...
- Subtasks use dot notation: N.1, N.2, ... Each subtask nests its own TDD cycle as sub-items: N.1.1 **RED:**, N.1.2 **GREEN:**, N.1.3 **REFACTOR:**
- Every TDD sub-item has a `Test:` line (acceptance criterion). Each subtask ends with a `_Requirements:_` line with context annotations (e.g., `_Requirements: R1 (validation logic), R3 (error handling)_`)
- Each deliverable must correspond to a concrete artifact: a file, function/class, API endpoint, CLI command, infrastructure resource, or configuration entry. Do not list abstract outcomes like "improved performance" as deliverables.
- Dependencies reference task numbers, not subtask numbers
- Implementation task deliverables use bold phase prefixes: `**RED:**`, `**GREEN:**`, `**REFACTOR:**` nested within each subtask — each subtask gets its own small TDD cycle. Checkpoint tasks and config-only infrastructure tasks are exempt (see Rule 10).
- The file starts with `# Tasks`, metadata, and the extracted requirements list
- The file ends with the Requirement Coverage table

**Rule 11 — Documentation Task:**
If the spec references user-facing behavior changes, API changes, configuration changes, or existing `.md` documentation files are related to the changes, add a task of type `checkpoint` titled "Documentation Review" that verifies:
- Affected `.md` files are updated (README, architecture docs, API docs)
- New features are documented if user-facing
- Configuration changes are documented
This task is checkpoint type (auto-TDD-exception) and should be the second-to-last task (before the final verification checkpoint).


---
name: split-in-tasks
description: Split a spec into small, ordered, deliverable tasks with requirement traceability
argument-hint: <TICKET_ID or folder name> [--force]
user-invocable: true
allowed-tools: Task, Bash, Read, Grep, Glob
---

# /split-in-tasks — Spec Decomposition into Implementation Tasks

Split a technical specification into small, ordered, dependency-aware tasks. Each task is tied back to specific requirements so the implementing agent never loses track of what needs to be built.

## Companion docs (read on demand)

| Doc | When to consult |
|---|---|
| [docs/decomposition-rules.md](./docs/decomposition-rules.md) | Rules 1–12 + anti-patterns for Step 4.1 |
| [docs/split-warning-passes.md](./docs/split-warning-passes.md) | Pass A / B / C static-analysis warnings emitted after Step 4 |
| [docs/output-format.md](./docs/output-format.md) | Exact `tasks.md` structure — task formats, file layout, format rules |
| [docs/test-command.md](./docs/test-command.md) | `### Test Command` block: runner env vars, file-name patterns, scope rules |
| [docs/scope-sections.md](./docs/scope-sections.md) | `### Files in scope` / `### Files explicitly out of scope` — Gate C + intra-ticket exclusion rule |

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

Apply ALL rules from **[docs/decomposition-rules.md](./docs/decomposition-rules.md)** (Rules 1–12 + the anti-pattern blocklist). The rules cover atomicity, requirement coverage, testability, ordering, TDD-cycle ownership inside a single task (Rule 10 is the most-violated — read it twice), parallelization, shared-resource detection, and the `task-description-quality.js` patterns that hard-fail at write time.

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
4. Generate the `Requirement Coverage` table (see [docs/output-format.md](./docs/output-format.md)).

**The trailing `## Requirement Coverage` table MUST be emitted in every `tasks.md`** even when per-task `### Requirements Covered` subsections are also present. The completion-checker parser primarily reads the top-level table; the subsection fallback exists as a safety net (see GH-462) but the table is still the source of truth. Omitting it forces the parser into the fallback path and obscures rollup status.

### Step 5: Quality review pass (MANDATORY — do this BEFORE saving)

Review all generated tasks and check:

- No task is too large (spans multiple components or outcomes)
- No task is trivial (less than ~5 minutes of work — merge it into an adjacent task)
- Dependencies are minimal (prefer independent tasks where possible)
- Parallelization is maximized safely (any task marked `No` that could be `Yes`?)
- Shared-resource detection: parallel tasks don't modify the same production files (if they do, extract a prerequisite — Rule 12 in [docs/decomposition-rules.md](./docs/decomposition-rules.md))
- Checkpoint tasks are present after every 3 implementation tasks or subsystem boundary
- TDD ordering is correct (RED before GREEN before REFACTOR in every non-exempt implementation task — see Rule 10 in [docs/decomposition-rules.md](./docs/decomposition-rules.md) for exemptions)
- Every non-checkpoint implementation task has a `### Test Command` with a real, runnable test command (see [docs/test-command.md](./docs/test-command.md))
- Gherkin coverage: every scenario from `gherkin.feature` is referenced by at least one task (if `gherkin.feature` exists)
- Anti-patterns are absent (see anti-pattern blocklist in [docs/decomposition-rules.md](./docs/decomposition-rules.md))
- Split-Warning Passes (Pass A / Pass B / Pass C — see [docs/split-warning-passes.md](./docs/split-warning-passes.md)) emit no unresolved `SPLIT-WARNING` lines, or each emitted warning has an operator-resolution decision recorded

Refactor tasks if any issues are found. Re-validate coverage after any refactoring.

### Step 6: Save output

Write the generated content to `${TASKS_DIR}/tasks.md`. The required structure, task formats (implementation + checkpoint), and format rules live in **[docs/output-format.md](./docs/output-format.md)**.

### Step 7: Summary

After saving, output:
- Confirm the file was saved and show the full path
- Show task count (implementation + checkpoint) and total subtask count
- Show requirement count and coverage status (all covered / N gaps)
- If any coverage gaps remain, list them explicitly
- Suggest next step: "Run `/work ${FOLDER_NAME}` to start implementation."

# Output Format

Defines the exact structure of `tasks.md`. See related docs:
- [test-command.md](./test-command.md) — `### Test Command` block details (runner env vars, file-name patterns, scope rules)
- [scope-sections.md](./scope-sections.md) — `### Files in scope` / `### Files explicitly out of scope` rules (Gate C + intra-ticket exclusion)

## Checkbox Legend
All deliverables start with `[ ]`. The workflow engine updates them automatically:
- `[ ]` — not started
- `[-]` — in progress (TDD initialized)
- `[x]` — implementation done (TDD evidence recorded)
- `[v]` — verified by completion-checker

## Task format (implementation tasks)

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
<shell command — see test-command.md for full rules>

### Suggested Scope, Files in scope, Files explicitly out of scope
<see scope-sections.md for full rules>

---
```

## Task format (checkpoint tasks)

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

## Full file structure

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

> **Note (GH-462):** The top-level `## Requirement Coverage` table above is MANDATORY in every emitted `tasks.md`. Each `## Task N` block must ALSO include a `### Requirements Covered` subsection listing the requirement IDs that task implements. The completion-checker parser reads the top-level table first; when absent or header-only, it aggregates the per-task `### Requirements Covered` subsections as a safety-net fallback (synthesizing rows with `status=DELIVERED`, `evidence=tasks.md:Task N`). Emit both — the dual-emission keeps the rollup table authoritative while ensuring the workflow never deadlocks if the table is accidentally omitted.

## Format rules

- Top-level tasks are numbered sequentially: Task 1, Task 2, ...
- Subtasks use dot notation: N.1, N.2, ... Each subtask nests its own TDD cycle as sub-items: N.1.1 **RED:**, N.1.2 **GREEN:**, N.1.3 **REFACTOR:**
- Every TDD sub-item has a `Test:` line (acceptance criterion). Each subtask ends with a `_Requirements:_` line with context annotations (e.g., `_Requirements: R1 (validation logic), R3 (error handling)_`)
- Each deliverable must correspond to a concrete artifact: a file, function/class, API endpoint, CLI command, infrastructure resource, or configuration entry. Do not list abstract outcomes like "improved performance" as deliverables.
- Dependencies reference task numbers, not subtask numbers
- Implementation task deliverables use bold phase prefixes: `**RED:**`, `**GREEN:**`, `**REFACTOR:**` nested within each subtask — each subtask gets its own small TDD cycle. Checkpoint tasks and config-only infrastructure tasks are exempt (see [decomposition-rules.md](./decomposition-rules.md) Rule 10).
- The file starts with `# Tasks`, metadata, and the extracted requirements list
- The file ends with the Requirement Coverage table

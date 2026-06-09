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
<one of the closed enum: tdd-code | tests-only | docs | config | ci | mechanical-refactor | file-move | checkpoint>

The closed enum is defined in [`lib/task-types.js`](../lib/task-types.js). Adding a new Type requires a code change there + a Pass D rule update in [`lib/lint-type-ac-consistency.js`](../lib/lint-type-ac-consistency.js); the planner cannot invent ad-hoc values. Each Type maps to a gate contract (see [`gateContractFor()`](../lib/task-types.js)):

- `tdd-code` — strict TDD: RED requires `*.test.*` authorship; GREEN/REFACTOR keep RC-D empty-output trap armed
- `tests-only` — RED is intentionally skipped (no failing test → passing impl loop); GREEN requires an in-scope test file to be modified
- `docs` — `.md`-only scope; verifier may be silent (grep / test -f)
- `config` — package.json / lockfiles / linter configs (see allowlist in task-types.js)
- `ci` — CI configs only (`.github/**`, `Jenkinsfile`, etc.)
- `mechanical-refactor` — pure transforms with no behavior change
- `file-move` — moves only, no edits beyond import updates
- `checkpoint` — verification-only; no source, no tests

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

## Common migration gotchas — build configs are NOT `Type: config`

`Type: config` is reserved for inert configuration (package.json, lockfiles, linter/formatter configs, `.editorconfig`, etc. — see `TYPE_SCOPE_RULES.config.scopePatterns` in [`../lib/task-types.js`](../lib/task-types.js) for the full allowlist). Build configs are deliberately excluded because they ship runtime behavior — a vite plugin, a webpack loader, or a jest setup file directly affects what runs in production or test.

When migrating an in-flight `tasks.md` to the closed Type taxonomy, the following files should use **`Type: tdd-code`**, not `Type: config`:

- `vite.config.{ts,js,mjs,cjs}`
- `rollup.config.{ts,js,mjs,cjs}`
- `webpack.config.{ts,js,mjs,cjs}`
- `jest.config.{ts,js,mjs,cjs}`
- `vitest.config.{ts,js,mjs,cjs}`
- `next.config.{ts,js,mjs,cjs}`
- `astro.config.{ts,js,mjs,cjs}`

These ship runtime behavior, so they need the full RED → GREEN → REFACTOR TDD cycle. Pass D will warn (`config allowlist`) if you list one under `Type: config`; the per-Type write guard in [`protect-task-scope.js`](../../../scripts/workflows/work/hooks/protect-task-scope.js) will then block the edit at implement time.

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

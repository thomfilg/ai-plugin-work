# Decomposition Rules

These rules apply to **Step 4.1 — Decompose into tasks** in [SKILL.md](../SKILL.md). Using the extracted requirement list as your guide, decompose the spec into tasks following ALL of these rules:

**Rule 1 — Atomicity:**
Each task must modify ONE logical component (e.g., one service, one UI module, one infrastructure unit) and produce ONE verifiable outcome (e.g., an API endpoint works, an agent classifies correctly, a DB table is created). If a task spans multiple components or produces multiple unrelated outcomes, split it.

**Rule 2 — Requirement Coverage:**
Every requirement from your Step 4.0 list must appear in at least one task's `Requirements Covered` section. Orphan requirements (in spec but not in any task) and orphan tasks (no requirement mapping) must be resolved in Step 4.3 before proceeding — add missing mappings or create/merge tasks until coverage is complete.

**Rule 3 — Independent Testability:**
Every task must be testable in isolation. If you can't write a test for it, it's not a task — it's part of another task.

**Rule 4 — No Overlap:**
No two tasks should deliver the same code or satisfy the same requirement. If a requirement needs work across multiple tasks, split the requirement's concerns explicitly so each task owns a distinct piece.

**Rule 4b — Every task MUST have a testable surface of its own:**
A task ships code OR tests that can be verified by THIS task's `### Test Command`, against ONLY files in THIS task's `### Files in scope`. Forbidden patterns (every one of these is a `split-in-tasks` authoring bug — merge with the consumer):

- **Helper-only task:** ships a pure helper or seed used solely by another task's test. There is no test for this helper in isolation. Merge it INTO the consuming task and list both the helper and its consumer's tests in that task's Files in scope.
- **Schema-narrowing-without-consumer task:** narrows a type/schema that another task's integration test depends on. The narrowing has no behavior change observable in isolation — merge it INTO the task whose test would otherwise fail without the narrowing.
- **"Run the dependent task's test" task:** a task whose Test Command points at a test file owned by another task. This is the ECHO-4637-class deadlock — caught by the tasks_gate validator.
- **"Run typecheck only" task:** Test Command is `pnpm typecheck` or any other compile-check that doesn't exercise behavior. Typecheck is not a behavior gate; if your task has no behavior to verify, merge it.

If you cannot write a unit or properly-scoped integration test for the task in isolation, the task should NOT exist as a separate task — merge it with its consumer.

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

**Rule 10 — TDD Ordering (CRITICAL — read this twice):**
Standard implementation tasks MUST order deliverables following the TDD cycle: RED (write failing tests) -> GREEN (implement to pass) -> REFACTOR (clean up). Each deliverable gets a bold phase prefix: `**RED:**`, `**GREEN:**`, `**REFACTOR:**`. When a task covers multiple behaviors, each behavior gets its own RED/GREEN/REFACTOR triplet.

**One full TDD cycle per task — never split phases across tasks.** R/G/R live inside a SINGLE task as nested deliverables (e.g. 1.1.1 RED, 1.1.2 GREEN, 1.1.3 REFACTOR). The implement-gate enforces RED→GREEN→REFACTOR within one task; if you put RED in Task N and GREEN in Task N+1, the gate wedges:

- Task N's RED test fails (expected) → gate records RED, demands GREEN within Task N
- GREEN means "make the test pass" → requires editing the impl file
- But the impl file is in Task N+1's scope, listed as out-of-scope for Task N → the implementing agent loops forever, blocked by its own decomposition

This is the **ECHO-4453-class wedge**. To avoid it:
- The same task must own BOTH the test file and the impl file in `### Files in scope`.
- The same task's Test Command must exercise the test added in its RED deliverable.
- Both test and impl edits must be reachable from inside ONE task's allowed surface.

✅ Correct (R/G/R inside one task):
```
## Task 1 — Backend: derive dashboardCount (full TDD cycle)
### Files in scope
- get.ts
- get.integration.test.ts
### Deliverables
- [ ] 1.1.1 **RED:** add failing test in get.integration.test.ts
- [ ] 1.1.2 **GREEN:** edit get.ts to make the test pass
- [ ] 1.1.3 **REFACTOR:** tidy reducer + JSDoc
```

❌ Wrong (R/G/R split across tasks — wedges):
```
## Task 1 — RED: add failing test
### Files in scope
- get.integration.test.ts
### Files explicitly out of scope
- get.ts   # ← GREEN can't reach this without scope violation
## Task 2 — GREEN: edit get.ts
```

**TDD-exempt Types** are exempt from the RED/GREEN/REFACTOR deliverables requirement. Per the closed taxonomy in [`lib/task-types.js`](../lib/task-types.js), TDD-required vs exempt partitions as:

- TDD-required: `tdd-code` (the only Type that runs the full RED→GREEN→REFACTOR cycle)
- TDD-exempt: `tests-only`, `docs`, `config`, `ci`, `mechanical-refactor`, `file-move`, `checkpoint`

**Build configs are NOT `Type: config`.** The `config` allowlist covers inert configuration (package.json, lockfiles, linter/formatter configs); it intentionally excludes build configs because they ship runtime behavior. Use `Type: tdd-code` (TDD-required) for:

- `vite.config.{ts,js,mjs,cjs}`
- `rollup.config.{ts,js,mjs,cjs}`
- `webpack.config.{ts,js,mjs,cjs}`
- `jest.config.{ts,js,mjs,cjs}`
- `vitest.config.{ts,js,mjs,cjs}`
- `next.config.{ts,js,mjs,cjs}`
- `astro.config.{ts,js,mjs,cjs}`

See [output-format.md "Common migration gotchas"](./output-format.md#common-migration-gotchas--build-configs-are-not-type-config) for the full rationale.

For exempt tasks, use a non-phase deliverables list that describes the concrete verifiable work in execution order, for example: `- Update config`, `- Validate config`, `- Document rollout/usage` as applicable. The implement-time gate maps each Type to a specific contract via `gateContractFor()` — `tests-only` for example uses `record-skip-red` for RED and requires an in-scope test-file modification at GREEN; `docs` accepts silent verifiers via the RC-D relaxation. **Storybook stories-only tasks** are detected by scope shape (every entry matches `*.stories.[jt]sx?`) and use the visual-only gate path.

For stories-only tasks, scope shape alone signals the exemption to the implement-gate: when every entry in `### Files in scope` matches `*.stories.[jt]sx?`, `task-next.js`'s `isVisualOnlyTask()` accepts the verification command as RED evidence — no `*.test.*` authorship file is required. Author a `### Test Strategy` block of `kind: custom` whose command runs lint + typecheck (see [`test-strategy.md`](./test-strategy.md) and [`../../../docs/test-strategy-kinds.md`](../../../docs/test-strategy-kinds.md) for the envelope), and document the visual artifact in deliverables. Do NOT mix story files with `.test.*`/`.spec.*` or production source in the same task's scope, or the exemption will not fire.

**Rule 11 — Documentation Task:**
If the spec references user-facing behavior changes, API changes, configuration changes, or existing `.md` documentation files are related to the changes, add a task of `### Type: docs` titled "Documentation Review" that verifies:
- Affected `.md` files are updated (README, architecture docs, API docs)
- New features are documented if user-facing
- Configuration changes are documented

This task uses `Type: docs` (the dedicated documentation contract in the closed taxonomy — see [`lib/task-types.js`](../lib/task-types.js)). It should be the second-to-last task (before the final verification checkpoint). The previous guidance to misuse `Type: checkpoint` for documentation is obsolete: docs tasks have their own scope-allowlist (`.md` only) and gate contract (silent verifiers accepted via the RC-D relaxation), so they get proper enforcement without piggybacking on the checkpoint exception.

**Rule 12 — Shared-Resource Detection (MANDATORY for parallel tasks):**
After marking tasks as `Parallel: Yes`, scan ALL parallel tasks' Suggested Scope for **overlapping production files**. If two or more parallel tasks modify the **same production file** (not test files — those don't conflict):
1. Extract the shared changes into a new **prerequisite task** that makes the shared modifications first
2. **Reorder all tasks** — the prerequisite becomes the first task (Task 1), and all subsequent tasks renumber accordingly. Never use "Task 0" — all tasks are numbered sequentially starting from 1.
3. Mark the prerequisite as `Parallel: No` with dependency `None`
4. Update all tasks that originally touched the shared file to depend on the prerequisite
5. The prerequisite task should ONLY make the shared changes (e.g., "add data-testid to BulkActionsDropdown"), not implement the full feature
6. Add a `## Parallelization Plan` section at the top of the file showing Wave 1 (prerequisite) → Wave 2 (parallel) → Wave 3 (checkpoints) structure

Example: If Task 3 and Task 5 both need to modify `BulkActionsDropdown.tsx`, create a new task for the shared changes, make it Task 1, renumber everything else, and mark the parallel tasks as depending on it.

## Anti-patterns

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

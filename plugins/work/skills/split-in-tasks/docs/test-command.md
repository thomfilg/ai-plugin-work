# Test Command Specification

This document covers the `### Test Command` block inside each task. See [output-format.md](./output-format.md) for the surrounding task structure.

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

## Test-file naming MUST match the chosen runner

(CRITICAL — the tasks_gate validator enforces this):

| Runner env var | File name pattern (ANY ONE must match) |
|---|---|
| `$TEST_INTEGRATION_COMMAND` | `**/*.integration.(test\|spec).(ts\|tsx\|js\|jsx\|mjs\|cjs)` OR `**/integration/**/*.(test\|spec).<ext>` |
| `$TEST_E2E_COMMAND` | `**/*.e2e.(test\|spec).(ts\|tsx\|js\|jsx\|mjs\|cjs)` OR `**/e2e/**/*.(test\|spec).<ext>` |
| `$TEST_UNIT_COMMAND` | Must NOT match either of the above patterns (no `.integration.` / `.e2e.` infix, not under `/integration/` or `/e2e/`) |

If a test file is misnamed for its runner, the vitest config silently routes it to a different runner (or skips it). The gate then can't pass because the test never executes — or it executes against the wrong fixtures. When creating a NEW test file, also name it correctly upfront and include the proposed filename in the task's `### Files in scope`.

## Test scope must equal task scope

(CRITICAL — prevents cross-task gate deadlocks):

A task's Test Command may ONLY exercise code declared in this task's `### Files in scope`. If the test passes through a network boundary (tRPC procedure, REST handler, GraphQL resolver), it ALSO traverses the input/output validators, middleware, and routing for that boundary — and those are owned by OTHER tasks. The gate then can't pass until every co-traversed task is also done, but each of those tasks is gated by its own test that needs THIS task done. Deadlock.

Symptoms when this is violated (don't ship a tasks.md with these):
- Task A's test executes a tRPC procedure but Task A only ships the inner helper — the procedure's output schema lives in Task B.
- Task A's Files in scope is one file, but its Test Command's CHANGED_FILES list spans 3 directories.
- A Zod / type error fires in the test that names a symbol declared by Task B.

Rules:
1. **Default to unit tests** for per-task gates. A task that ships `lib/foo/helper.ts` should test the helper directly: `CHANGED_FILES="lib/foo/__tests__/helper.test.ts" eval "$TEST_UNIT_COMMAND"`. Do NOT test it through a procedure / handler / resolver unless that procedure is also in this task's Files in scope.
2. **Use integration tests only when the task owns the entire boundary** — handler + validator + helper all listed under this task's Files in scope. Otherwise the integration test couples this task to its siblings.
3. **Reserve cross-cutting integration tests for the final `checkpoint` task** — that task's scope is "verify the whole feature works end-to-end" and explicitly depends on every prior task.
4. **Audit every Test Command before emitting tasks.md**: for each task, walk the file list in CHANGED_FILES and confirm every file appears under this task's Files in scope. If any file is owned by a different task, switch to a narrower unit test or expand the scope.

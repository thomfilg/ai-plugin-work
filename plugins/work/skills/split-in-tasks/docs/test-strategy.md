# Test Strategy Specification

This document covers the `### Test Strategy` block inside each task. See [output-format.md](./output-format.md) for the surrounding task structure. This file folds in (and supersedes) the legacy `test-command.md`: every task now declares a structured **Test Strategy** with a `kind:` discriminator instead of a free-form `### Test Command` shell line.

For the short, "explain it to me in one screen" overview, see [`../../../docs/test-strategy-kinds.md`](../../../docs/test-strategy-kinds.md).

## The five kinds

Every `### Test Strategy` block MUST declare exactly one `kind:` value from the closed enum below. The implement-gate's command-existence dispatcher routes the recorded command to a runner based on this kind.

| `kind:`         | When to use                                                                                                | Required keys                       |
|-----------------|------------------------------------------------------------------------------------------------------------|-------------------------------------|
| `unit`          | Per-task gate for a unit/component change — one or more `*.test.*` files under this task's Files in scope. | `entry:` (test file path)           |
| `integration`   | Task owns the entire boundary (handler + validator + helper) and the test exercises the boundary together. | `entry:` (`*.integration.test.*`)   |
| `e2e`           | Playwright E2E spec under `tests/e2e/**` that drives the UI end-to-end.                                    | `entry:` (`*.e2e.test.*` or `tests/e2e/**`) |
| `custom`        | Verification command that isn't a standard test runner (e.g. `pnpm dev:check` for stories-only tasks).      | `command:` (verbatim shell command — MUST resolve to an executable pnpm script or binary) |
| `verified-by`   | Coverage delegated to a peer task whose test already exercises this task's scope.                          | `peer:` (Task number) + cited symbol/path |

## Block format

The `### Test Strategy` block is a fenced YAML-shaped body. Pick the kind, then fill in the minimum required keys:

```markdown
### Test Strategy
kind: unit
entry: components/workbooks/workbook-views-content/workbook-subscriptions-tab-content.test.tsx
```

```markdown
### Test Strategy
kind: integration
entry: server/api/admin/__tests__/general-settings.integration.test.ts
```

```markdown
### Test Strategy
kind: e2e
entry: tests/e2e/specs/workbook-detail/workbook-detail-subscriptions-tab.spec.ts
```

```markdown
### Test Strategy
kind: custom
command: CHANGED_FILES="$(git diff --name-only HEAD)" eval "$TEST_UNIT_COMMAND"
```

```markdown
### Test Strategy
kind: verified-by
peer: Task 7
cites: server/api/admin/general-settings.router.ts
```

## Runner dispatch via the `$TEST_*_COMMAND` envelope

Authors do NOT write `pnpm test` / `pnpm e2e` / `pnpm dev:check` directly. The implement-gate resolves the kind to a runner env var via the project's `.envrc`:

| `kind:`        | Resolves to env var          |
|----------------|------------------------------|
| `unit`         | `$TEST_UNIT_COMMAND`         |
| `integration`  | `$TEST_INTEGRATION_COMMAND`  |
| `e2e`          | `$TEST_E2E_COMMAND`          |
| `custom`       | the `command:` field verbatim |
| `verified-by`  | the peer task's runner       |

The literal `$CHANGED_FILES` placeholder inside these env vars is substituted with the space-separated list of files YOU changed. The gate prefixes the command before executing:

```bash
CHANGED_FILES="<entry from your Test Strategy>" eval "$TEST_UNIT_COMMAND"
```

Hardcoded shell strings (e.g. `pnpm test:foo path/to/file`) are **only** allowed under `kind: custom`, and only when a project explicitly opts out of env-var-based runners (rare — flag this with the user before falling back).

## Test-file naming MUST match the chosen kind

(CRITICAL — the tasks_gate validator enforces this):

| `kind:`         | File name pattern (ANY ONE must match)                                                                            |
|-----------------|-------------------------------------------------------------------------------------------------------------------|
| `integration`   | `**/*.integration.(test\|spec).(ts\|tsx\|js\|jsx\|mjs\|cjs)` OR `**/integration/**/*.(test\|spec).<ext>`           |
| `e2e`           | `**/*.e2e.(test\|spec).(ts\|tsx\|js\|jsx\|mjs\|cjs)` OR `**/e2e/**/*.(test\|spec).<ext>`                          |
| `unit`          | Must NOT match either of the above patterns (no `.integration.` / `.e2e.` infix, not under `/integration/` or `/e2e/`) |
| `custom`        | N/A — `command:` is opaque to the file-name validator                                                             |
| `verified-by`   | Inherits the peer's pattern; validator follows the citation                                                       |

If a test file is misnamed for its kind, the vitest config silently routes it to a different runner (or skips it). The gate then can't pass because the test never executes — or it executes against the wrong fixtures. When creating a NEW test file, also name it correctly upfront and include the proposed filename in the task's `### Files in scope`.

## Test scope must equal task scope

(CRITICAL — prevents cross-task gate deadlocks):

A task's Test Strategy may ONLY exercise code declared in this task's `### Files in scope`. If the test passes through a network boundary (tRPC procedure, REST handler, GraphQL resolver), it ALSO traverses the input/output validators, middleware, and routing for that boundary — and those are owned by OTHER tasks. The gate then can't pass until every co-traversed task is also done, but each of those tasks is gated by its own test that needs THIS task done. Deadlock.

Symptoms when this is violated (don't ship a tasks.md with these):
- Task A's `entry:` is a tRPC procedure test but Task A only ships the inner helper — the procedure's output schema lives in Task B.
- Task A's Files in scope is one file, but its `entry:` spans 3 directories.
- A Zod / type error fires in the test that names a symbol declared by Task B.

Rules:
1. **Default to `kind: unit`** for per-task gates. A task that ships `lib/foo/helper.ts` should test the helper directly via `entry: lib/foo/__tests__/helper.test.ts`. Do NOT test it through a procedure / handler / resolver unless that procedure is also in this task's Files in scope.
2. **Use `kind: integration` only when the task owns the entire boundary** — handler + validator + helper all listed under this task's Files in scope. Otherwise the integration test couples this task to its siblings.
3. **Reserve cross-cutting `kind: e2e` for the final `checkpoint` task** — that task's scope is "verify the whole feature works end-to-end" and explicitly depends on every prior task.
4. **Use `kind: verified-by` to model TDD-ownership** — when a sibling's test already exercises this task's scope, point at the sibling instead of duplicating the assertion. The TDD-ownership graph validator rejects an owned-but-uncovered path.
5. **Audit every Test Strategy before emitting tasks.md**: for each task, walk the `entry:` (or peer citation) and confirm every file appears under this task's Files in scope. If any file is owned by a different task, switch to a narrower unit test or expand the scope.

## Migration notes (from the legacy `### Test Command` block)

- The previous `### Test Command` shell line is REPLACED by `### Test Strategy` with a `kind:` discriminator.
- The free-form shell remains accessible via `kind: custom` with a `command:` key (the same shell you used to write).
- The `WORK_TEST_STRATEGY_VALIDATOR=1` feature flag gates the new draft-time validators. Until the flag is enabled in `.envrc`, in-flight `tasks.md` files using the legacy `### Test Command` continue to validate.

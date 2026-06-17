# Test Strategy Kinds — short explainer

Each task in `tasks.md` declares a `### Test Strategy` block whose first line is a `kind:` discriminator drawn from a closed enum. The implement-gate's command-existence dispatcher resolves the kind to a runner (or peer citation), so authors NEVER hardcode `pnpm test` / `pnpm e2e` / `pnpm dev:check` shell paths.

For the full spec see [`../skills/split-in-tasks/docs/test-strategy.md`](../skills/split-in-tasks/docs/test-strategy.md).

## The five kinds (one example each)

### `kind: unit`
Default for per-task gates. The `entry:` points at a `*.test.*` file under this task's Files in scope; the gate prefixes `CHANGED_FILES="<entry>"` before invoking `$TEST_UNIT_COMMAND`.

```markdown
### Test Strategy
kind: unit
entry: lib/foo/__tests__/helper.test.ts
```

### `kind: integration`
Task owns the entire boundary (handler + validator + helper) and the test exercises the boundary together. Resolves to `$TEST_INTEGRATION_COMMAND`.

```markdown
### Test Strategy
kind: integration
entry: server/api/admin/__tests__/general-settings.integration.test.ts
```

### `kind: e2e`
Playwright spec under `tests/e2e/**`. Typically reserved for the final `checkpoint` task. Resolves to `$TEST_E2E_COMMAND`.

```markdown
### Test Strategy
kind: e2e
entry: tests/e2e/specs/workbook-detail/workbook-detail-subscriptions-tab.spec.ts
```

### `kind: custom`
Escape hatch for non-test verification commands (e.g. stories-only tasks that run lint + typecheck via the bundled `dev-check.sh`). `command:` is taken verbatim. The command-existence dispatcher verifies the binary / pnpm script exists before the gate accepts it.

```markdown
### Test Strategy
kind: custom
command: CHANGED_FILES="$(git diff --name-only HEAD)" eval "$TEST_UNIT_COMMAND"
```

### `kind: verified-by`
Coverage delegated to a peer task whose test already exercises this task's scope. The TDD-ownership-graph validator follows the citation and rejects an owned-but-uncovered path.

```markdown
### Test Strategy
kind: verified-by
peer: Task 7
cites: server/api/admin/general-settings.router.ts
```

## When `kind: custom` is appropriate

`kind: custom` exists for genuine non-test verification (visual-only tasks, codegen audits, schema sync checks). It is NOT a way to opt out of writing a test for behavioral changes — the TDD-ownership-graph validator (`lib/tdd-ownership-graph.js`) flags every path in `### Files in scope` that no task's Test Strategy `entry` transitively covers. A `kind: custom` task whose scope contains production source therefore produces "owned but uncovered" orphan errors during the draft phase. Use `kind: unit` (or `kind: integration` / `kind: e2e` as appropriate) when the task ships behavioral code.

## Feature flag

The draft-time enum validator is gated by `WORK_TEST_STRATEGY_VALIDATOR=1` (default `0`). Until set in `.envrc`, in-flight tasks using the legacy `### Test Command` shell line continue to validate so authors are not blocked mid-stream.

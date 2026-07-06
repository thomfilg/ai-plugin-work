# /work-implement Workflow

Quick TDD-gated implementation that skips brief/spec/tasks generation. Used for standalone implementation tasks or within `/work` at the implement step.

## Invocation

```
/work-implement TICKET-123
/work-implement TICKET-123 --task 3
```

## TDD Phase Cycle

Every implementation follows the RED → GREEN → REFACTOR cycle:

```
RED ──────────► GREEN ──────────► REFACTOR
(write tests)   (make pass)       (clean up)
     │                                │
     └────────────────────────────────┘
              (next cycle)
```

### RED Phase

**Goal:** Write failing tests that define the expected behavior.

**Hook enforcement:** Blocks Write/Edit to non-test files.

**Allowed files:** Files matching `/\.test\.[jt]sx?$/` or `/\.spec\.[jt]sx?$/` — i.e., `*.test.ts`, `*.test.tsx`, `*.test.js`, `*.test.jsx`, `*.spec.ts`, `*.spec.tsx`, `*.spec.js`, `*.spec.jsx`. Helpers (`__mocks__/`, `__fixtures__/`, `test-utils/`) are blocked in RED.

**Evidence required:** Test files changed + test command exits with non-zero code.

### GREEN Phase

**Goal:** Write minimal production code to make tests pass.

**Hook enforcement:** Blocks Write/Edit to test files (except helpers).

**Allowed files:** All non-test source files, plus test helpers (`__mocks__/*`, `__fixtures__/*`, `test-utils/*`).

**Evidence required:** Test command exits with code 0.

### REFACTOR Phase

**Goal:** Clean up code while keeping tests green.

**Hook enforcement:** None — all file edits allowed.

**Evidence required:** Test command still exits with code 0.

## Task Runner (multi-task mode)

**File:** `scripts/workflows/work-implement/task-next.js`

When `tasks.md` exists, developer agents drive the whole cycle through ONE command — they never pick a test command and never call the recorder directly:

```bash
node task-next.js TICKET-123 task3
node task-next.js TICKET-123 task3 --resume-completed   # machine-verified resume (GH-509)
```

On each invocation the runner reads the per-task state, resolves the runnable command from the task's `### Test Strategy` block via the shared implement-gate resolver (envelope kinds synthesize `CHANGED_FILES="<entry>" eval "$TEST_*_COMMAND"` with `.envrc` vars folded in; `custom` runs verbatim; citation kinds `verified-by`/`wiring-citation` record GREEN by validated peer citation instead of executing), validates the phase rules for the task's `### Type`, records evidence through `tdd-phase-state.js`, and prints the next-phase instructions. Planner defects (malformed strategy, hanging command, Type mismatch) block with a `BLOCKED (planner-defect)` message — tasks.md is planner-owned and locked during implement.

## TDD Phase State CLI

**File:** `scripts/workflows/work-implement/tdd-phase-state.js`

All subcommands support `--task N` for per-task scoping.

### Commands

```bash
# Initialize TDD state
node tdd-phase-state.js init TICKET-123 --task 1

# Check current phase
node tdd-phase-state.js current TICKET-123 --task 1

# Record RED phase (runs tests, expects failure — a load crash or timeout is rejected)
node tdd-phase-state.js record-red TICKET-123 --task 1 --cmd "npm test"

# Record GREEN phase (runs tests, expects success)
node tdd-phase-state.js record-green TICKET-123 --task 1 --cmd "npm test"

# Record REFACTOR phase (runs tests, expects success)
node tdd-phase-state.js record-refactor TICKET-123 --task 1 --cmd "npm test"

# Record intentionally-skipped RED (tests-only contract)
node tdd-phase-state.js record-skip-red TICKET-123 --task 1 --reason "why"

# Record machine-verified resume (normally reached via task-next.js --resume-completed)
node tdd-phase-state.js record-resume-completed TICKET-123 --task 1 --cmd "npm test"

# Transition to next phase
node tdd-phase-state.js transition TICKET-123 green --task 1

# Exception mode (OPERATOR-ONLY — requires WORK_OPERATOR_TOKEN=1)
node tdd-phase-state.js exception TICKET-123 --task 1 --category config --reason "config-only change"
```

### Token Gating

Gated subcommands (`record-red`, `record-skip-red`, `record-green`, `record-refactor`, `record-resume-completed`, `transition`, `exception`) require a valid token. Tokens are issued by `enforce-step-workflow.js` Rule 5 and consumed by the CLI. This prevents agents from self-reporting evidence.

Set `WORK_TDD_TOKEN_SKIP=1` for standalone/debugging use.

## State File

**Location:** `TASKS_BASE/<ticket>/taskN/tdd-phase.json` (per-task) or `TASKS_BASE/<ticket>/tdd-phase.json` (legacy root)

```json
{
  "currentPhase": "refactor",
  "currentCycle": 1,
  "cycles": [
    {
      "cycle": 1,
      "red": {
        "testFiles": ["src/foo.test.ts"],
        "testCommand": "npm test",
        "testExitCode": 1,
        "timestamp": "2026-04-22T13:29:32.249Z"
      },
      "green": {
        "testCommand": "npm test",
        "testExitCode": 0,
        "timestamp": "2026-04-22T13:38:20.418Z"
      },
      "refactor": {
        "testCommand": "npm test",
        "testExitCode": 0,
        "timestamp": "2026-04-22T13:38:46.873Z"
      }
    }
  ]
}
```

## Exception Mode (Operator-Only)

The `exception` subcommand is an operator-only escape hatch requiring `WORK_OPERATOR_TOKEN=1` (agent environments never carry it). Agents get TDD exemptions exclusively from the planner's `### Type` taxonomy (`tests-only`, `docs`, `config`, `ci`, `mechanical-refactor`, `file-move`, `checkpoint` — the closed enum in `skills/split-in-tasks/lib/task-types.js`). It writes a structured exception state:

```json
{
  "currentPhase": "exception",
  "exception": {
    "category": "config",
    "reason": "config-only change, no testable behavior"
  },
  "cycles": []
}
```

**Validation** (GH-258 closed):
- `--category` must be one of the shared `TDD_EXEMPT_TYPES` (or the legacy alias `config-only` for `config`); `--reason` must be non-empty.
- `checkpoint` requires `--task <N>` and is verified against tasks.md.
- Rejected when any changed/staged/untracked source file contains exports — new exported code requires TDD.
- Every invocation (allowed or rejected) is audited to `.work-actions.json` as a `tdd-exception` enforcement row.

## File Gating Hook

**File:** `scripts/workflows/work-implement/hooks/work-implement-enforce.js`

Registered in `hooks/hooks.json` (PreToolUse, matcher `Edit|Write|MultiEdit`, after the protect-* hooks; fail-open when no implement step is active). It blocks file edits based on the current TDD phase:

| Phase | Write/Edit to test file | Write/Edit to source file |
|---|---|---|
| RED | ALLOW | BLOCK |
| GREEN | BLOCK (except helpers) | ALLOW |
| REFACTOR | ALLOW | ALLOW |
| exception | ALLOW | ALLOW |

**Test file detection** (`tdd-phase-registry.js`):
- `.test.ts`, `.test.tsx`, `.test.js`, `.test.jsx`
- `.spec.ts`, `.spec.tsx`, `.spec.js`, `.spec.jsx`

**Test helper detection** (from `TEST_HELPER_PATTERNS`):
- `__mocks__/*`, `__fixtures__/*`
- `test-utils/`, `test-utils.[jt]sx?`, `test-helper/`
- Helpers are writable in GREEN and REFACTOR, but blocked in RED

## Stop Gating Hook

**File:** `scripts/workflows/work-implement/hooks/enforce-tdd-on-stop.js`

Registered in `hooks/hooks.json` (SubagentStop, matcher `.*`). Self-filters (exit 0) for non-`developer-*` subagents, undetectable tickets, non-`implement` steps, and checkpoint tasks. When a developer agent stops during `implement` without valid TDD evidence for the task's `### Type` (judged by the shared `validateTddEvidenceForType` — the same rule the implement gate and the check/complete validators apply, so TDD-exempt Types are satisfied by red-only/green-only evidence such as the gate's non-TDD stub), it blocks (exit 2) and prints the ONE next command (`task-next.js`) — it never runs tests or records evidence itself. Citation-kind GREEN evidence satisfies it; a task with no resolvable `### Test Strategy` is allowed to stop but audited (`tdd-stop-strategy-missing-allow` in `.work-actions.json`).

## Evidence Validation

**File:** `scripts/workflows/work/lib/tdd-enforcement.js`

The `/work` orchestrator (and the stop hook) validate TDD evidence via the ONE shared contract-aware validator `validateTddEvidenceForType(evidence, taskType)` before allowing transition out of `implement` — the SAME function the implement gate, `check-gate.js` (`per-task-tdd-evidence`), and `workflow-definition.js verifyPerTaskTDD` consume, so evidence the gate advances on can never dead-end downstream. Evidence is valid when any of these holds:

- the task's `### Type` is TDD-exempt (`task-types.js TDD_EXEMPT_TYPES`) and at least one cycle carries `red` OR `green` evidence (stub or real — e.g. the gate's non-TDD pre-test stub), or
- a structured exception `{ category, reason }` with a category from the shared exemption enum (legacy bare-string exceptions still accepted), or
- at least one cycle with both `red` and `green` evidence, or
- a green-only citation cycle (`green.kind` = `verified-by`/`wiring-citation`) with `peerSha` present.

Unknown or missing Types validate strictly (fail closed). The plain `validateTddEvidence` remains as the strict rule the wrapper delegates to.

See [tdd-enforcement.md](./tdd-enforcement.md) for the full rules, hang/load-failure rejection, and the machine-verified resume and ablation paths.

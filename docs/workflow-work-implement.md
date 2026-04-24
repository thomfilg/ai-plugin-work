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

## TDD Phase State CLI

**File:** `workflows/work-implement/tdd-phase-state.js`

All subcommands support `--task N` for per-task scoping.

### Commands

```bash
# Initialize TDD state
node tdd-phase-state.js init TICKET-123 --task 1

# Check current phase
node tdd-phase-state.js current TICKET-123 --task 1

# Record RED phase (runs tests, expects failure)
node tdd-phase-state.js record-red TICKET-123 --task 1 --cmd "npm test"

# Record GREEN phase (runs tests, expects success)
node tdd-phase-state.js record-green TICKET-123 --task 1 --cmd "npm test"

# Record REFACTOR phase (runs tests, expects success)
node tdd-phase-state.js record-refactor TICKET-123 --task 1 --cmd "npm test"

# Transition to next phase
node tdd-phase-state.js transition TICKET-123 green --task 1

# Exception mode (skip TDD for mechanical changes)
node tdd-phase-state.js exception TICKET-123 --task 1 --category config-only --reason "config-only change"
```

### Token Gating

Gated subcommands (`record-red`, `record-green`, `record-refactor`, `transition`) require a valid token. Tokens are issued by `enforce-step-workflow.js` Rule 5 and consumed by the CLI. This prevents agents from self-reporting evidence.

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

## Exception Mode

For purely mechanical changes (config-only, file moves, no testable behavior), the exception subcommand bypasses TDD:

```json
{
  "currentPhase": "exception",
  "exception": "config-only change, no testable behavior",
  "cycles": []
}
```

**Documented valid reasons:**
- Config-only changes (vite.config, tsconfig, etc.)
- File moves/renames with no behavior change
- Non-testable infrastructure changes

**Validation:** Currently accepts any non-empty string. See [GH-258](https://github.com/tigredonorte/claude-plugin-work/issues/258) for planned hardening.

## File Gating Hook

**File:** `workflows/work-implement/hooks/work-implement-enforce.js`

This PreToolUse hook blocks file edits based on the current TDD phase:

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

## Evidence Validation

**File:** `workflows/work/tdd-enforcement.js`

The `/work` orchestrator validates TDD evidence before allowing transition out of `implement`:

```javascript
function validateTddEvidence(evidence) {
  // Exception mode: valid if reason is non-empty
  if (typeof evidence.exception === 'string' && evidence.exception.trim() !== '') {
    return { valid: true, reason: '' };
  }
  // Normal mode: at least one cycle with red + green evidence
  if (!Array.isArray(evidence.cycles) || evidence.cycles.length === 0) {
    return { valid: false, reason: 'No TDD cycles recorded' };
  }
  return evidence.cycles.some(c => c.red && c.green)
    ? { valid: true, reason: '' }
    : { valid: false, reason: 'No complete RED→GREEN cycle' };
}
```

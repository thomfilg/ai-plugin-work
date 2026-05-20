# TDD Enforcement

The TDD enforcement system ensures that all code changes follow the RED → GREEN → REFACTOR discipline. It operates through three layers: phase gating (hooks), evidence recording (CLI), and evidence validation (orchestrator).

## Three Layers

### Layer 1: Phase Gating (Hook)

**File:** `scripts/workflows/work-implement/hooks/work-implement-enforce.js`

A PreToolUse hook that blocks file edits based on the current TDD phase:

| Current Phase | Edit test file | Edit source file | Edit helper |
|---|---|---|---|
| RED | ALLOW | BLOCK | BLOCK |
| GREEN | BLOCK | ALLOW | ALLOW |
| REFACTOR | ALLOW | ALLOW | ALLOW |
| exception | ALLOW | ALLOW | ALLOW |

Note: In RED phase, only files matching `.test.*` or `.spec.*` patterns are allowed. Helpers (`__mocks__/`, `__fixtures__/`, `test-utils/`) are classified separately and blocked in RED. In GREEN phase, test files are blocked but helpers are explicitly allowed (`isTestFile && !isTestHelper`).

**File classification** (`tdd-phase-registry.js`):

- **Test files:** Matches `TEST_FILE_PATTERNS`: `/\.test\.[jt]sx?$/`, `/\.spec\.[jt]sx?$/`
- **Test helpers:** Matches `TEST_HELPER_PATTERNS`: `__mocks__/`, `__fixtures__/`, `test-utils/`, `test-utils.[jt]sx?`, `test-helper/`
- **Source files:** Everything else

Note: `isTestHelper()` returns false if the file also matches `isTestFile()` — a file named `test-utils.test.ts` is a test file, not a helper.

### Layer 2: Evidence Recording (CLI)

**File:** `scripts/workflows/work-implement/tdd-phase-state.js`

Only this CLI can record TDD evidence — agents cannot self-report. Evidence includes:

| Phase | What's recorded |
|---|---|
| RED | Test files changed, test command, exit code (must be non-zero), timestamp |
| GREEN | Test command, exit code (must be 0), timestamp |
| REFACTOR | Test command, exit code (must be 0), timestamp |

**Token gating:** Gated subcommands (`record-red`, `record-green`, `record-refactor`, `transition`) require a token issued by `enforce-step-workflow.js` Rule 5. This prevents unauthorized evidence injection.

**Authorized agents:** `developer-nodejs-tdd`, `developer-react-senior`, `developer-react-ui-architect`, `developer-devops`

### Layer 3: Evidence Validation (Orchestrator)

**File:** `scripts/workflows/work/tdd-enforcement.js`

The `/work2` orchestrator validates TDD evidence before allowing transition out of `implement`:

```javascript
function validateTddEvidence(evidence) {
  // Exception: valid if reason is non-empty
  if (typeof evidence.exception === 'string' && evidence.exception.trim() !== '') {
    return { valid: true, reason: '' };
  }
  // Normal: at least one cycle with red + green
  if (!Array.isArray(evidence.cycles) || evidence.cycles.length === 0) {
    return { valid: false, reason: 'No TDD cycles recorded' };
  }
  return evidence.cycles.some(c => c.red && c.green)
    ? { valid: true, reason: '' }
    : { valid: false, reason: 'No complete RED→GREEN cycle' };
}
```

## Phase Transitions

**File:** `scripts/workflows/work-implement/tdd-phase-registry.js`

Valid transitions:

```
red → green → refactor → red (cyclic)
```

`exception` is not part of the transition graph — it is set directly by the `cmdException()` function, bypassing `tddCanTransition()`. It overwrites the entire state file with `{ currentPhase: 'exception', exception: reason, cycles: [] }`.

The `tddCanTransition(from, to)` function only enforces the `red → green → refactor → red` cycle.

## State File

**Per-task:** `TASKS_BASE/<ticket>/taskN/tdd-phase.json`
**Legacy root:** `TASKS_BASE/<ticket>/tdd-phase.json`

### Normal cycle

```json
{
  "currentPhase": "refactor",
  "currentCycle": 1,
  "cycles": [
    {
      "cycle": 1,
      "red": {
        "testFiles": ["src/feature.test.ts"],
        "testCommand": "npm test -- --filter feature",
        "testExitCode": 1,
        "timestamp": "2026-04-22T13:29:32.249Z"
      },
      "green": {
        "testCommand": "npm test -- --filter feature",
        "testExitCode": 0,
        "timestamp": "2026-04-22T13:38:20.418Z"
      },
      "refactor": {
        "testCommand": "npm test -- --filter feature",
        "testExitCode": 0,
        "timestamp": "2026-04-22T13:38:46.873Z"
      }
    }
  ]
}
```

### Multiple cycles

When refactoring reveals need for more behavior:

```json
{
  "currentPhase": "green",
  "currentCycle": 2,
  "cycles": [
    { "cycle": 1, "red": {...}, "green": {...}, "refactor": {...} },
    { "cycle": 2, "red": {...} }
  ]
}
```

### Exception mode

```json
{
  "currentPhase": "exception",
  "exception": "config-only change, no testable behavior",
  "cycles": []
}
```

## Exception Mode

**Valid reasons** (documented, not yet enforced programmatically):
- Config-only changes (vite.config, tsconfig, package.json)
- File moves/renames with no behavior change
- Non-testable infrastructure changes (CI/CD, Dockerfiles)

**Known gap:** Any non-empty string is accepted. See [GH-258](https://github.com/tigredonorte/claude-plugin-work/issues/258).

## Per-Task vs Root State

When `tasks.md` exists (multi-task mode):
- Each task gets its own `taskN/tdd-phase.json`
- The `--task N` flag routes to the per-task path
- No fallback to root (GH-219 Task 1)

When no `tasks.md` (single-task mode):
- Root `tdd-phase.json` is used
- `--task` flag is omitted

**Path resolution** (`tdd-phase-state.js:getStatePath()`):
```
With --task 3:  TASKS_BASE/<ticket>/task3/tdd-phase.json
Without --task: TASKS_BASE/<ticket>/tdd-phase.json
```

## Auto-Initialization

When the `/work2` orchestrator transitions to the `implement` step, it automatically initializes `tdd-phase.json` with RED phase:

```javascript
// work-state.js:autoInitTdd()
function autoInitTdd(ticketId, taskNum) {
  const state = { currentPhase: 'red', currentCycle: 1, cycles: [] };
  // Atomic exclusive create (wx flag) — idempotent
  fs.openSync(tddStatePath, 'wx');
  fs.writeFileSync(fd, JSON.stringify(state, null, 2));
}
```

This forces the developer agent to write tests first before any implementation.

## CLI Reference

```bash
# Initialize
node tdd-phase-state.js init TICKET-123 [--task N]

# Check current phase
node tdd-phase-state.js current TICKET-123 [--task N]

# Record phases (runs test command internally)
node tdd-phase-state.js record-red TICKET-123 --cmd "npm test" [--task N]
node tdd-phase-state.js record-green TICKET-123 --cmd "npm test" [--task N]
node tdd-phase-state.js record-refactor TICKET-123 --cmd "npm test" [--task N]

# Manual transition
node tdd-phase-state.js transition TICKET-123 green [--task N]

# Exception mode
node tdd-phase-state.js exception TICKET-123 --category <category> --reason "reason" [--task N]
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `WORK_TDD_TOKEN_SKIP` | `0` | Skip token verification (debugging) |
| `TASKS_BASE` | from config | State file root |
| `ENFORCE_HOOK_DEBUG` | `0` | Verbose hook logging |

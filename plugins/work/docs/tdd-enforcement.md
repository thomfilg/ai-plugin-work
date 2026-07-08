# TDD Enforcement

The TDD enforcement system ensures that all code changes follow the RED → GREEN → REFACTOR discipline. It operates through four layers: phase gating (PreToolUse hook), stop gating (SubagentStop hook), evidence recording (CLI), and evidence validation (orchestrator).

TDD is required only for `### Type: tdd-code` tasks. The TDD-exempt Types (`tests-only`, `docs`, `config`, `ci`, `mechanical-refactor`, `file-move`, `checkpoint`) are defined once in `skills/split-in-tasks/lib/task-types.js` (`TDD_EXEMPT_TYPES` / `isTddRequired` / `gateContractFor`) and consumed by every enforcement surface — the recorder, the implement gate, the stop hook, and the tasks-phase validators all delegate to that single taxonomy.

## Four Layers

### Layer 1: Phase Gating (PreToolUse Hook)

**File:** `scripts/workflows/work-implement/hooks/work-implement-enforce.js`

Registered in `hooks/hooks.json` under PreToolUse with matcher `Edit|Write|MultiEdit`, after the protect-* hooks. Fail-open (exit 0) when no workflow/implement step is active. It blocks file edits based on the current TDD phase:

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

### Layer 2: Stop Gating (SubagentStop Hook)

**File:** `scripts/workflows/work-implement/hooks/enforce-tdd-on-stop.js`

Registered in `hooks/hooks.json` under a `SubagentStop` event with matcher `.*` — the hook self-filters (exit 0, fail-open) instead of relying on the matcher: non-`developer-*` subagents, undetectable ticket IDs, unreadable work state, non-`implement` steps, and checkpoint tasks all pass through untouched.

When a developer agent stops during `implement` without valid TDD evidence, the hook blocks (exit 2) and prints the ONE next command — the `task-next.js` invocation for the active task. It NEVER runs tests or records evidence itself (an earlier auto-record path was removed: it fabricated evidence with `WORK_TDD_TOKEN_SKIP=1` and a command that could differ from `task-next`'s, skipping kind-aware gates).

Allowed stops (judged by the shared `validateTddEvidenceForType` — the SAME contract-aware rule the implement gate and the check/complete validators apply):
- A TDD-exempt `### Type` (docs / config / ci / tests-only / mechanical-refactor / file-move) with red-only or green-only evidence — e.g. the gate's non-TDD pre-test stub is a complete record for those Types.
- A complete RED → GREEN cycle or a recorded exception (the strict `validateTddEvidence` rule, applied to TDD-required and unknown Types — fail closed).
- Citation-kind GREEN evidence (`verified-by` / `wiring-citation` with `peerSha`) — a green-only citation cycle IS complete because citation kinds have no runnable command.
- A task whose `### Test Strategy` does not resolve to a runnable command (legacy tickets) — allowed but AUDITED: an enforcement row (action `tdd-stop-strategy-missing-allow`) is appended to `.work-actions.json` so the bypass is visible.

The worktree directory is resolved from `WORK_WORKTREE_DIR` / `.work-state.json` / the worktree convention, with `process.cwd()` only as last resort.

### Layer 3: Evidence Recording (CLI)

**Files:** `scripts/workflows/work-implement/tdd-phase-state.js` (recorder) and `scripts/workflows/work-implement/task-next.js` (agent entrypoint)

Only the recorder CLI can record TDD evidence — agents cannot self-report. In multi-task mode (`tasks.md` exists), agents never call the recorder directly: `task-next.js <TICKET> task<N>` is the single entrypoint. It resolves the runnable command from the task's `### Test Strategy` block via the SAME shared resolver the implement gate and the stop hook use (`resolveTaskTestExecution` → `lib/test-strategy.js synthesizeCommand`), runs it, validates the phase rules (kind- and Type-aware), and delegates the write to the recorder. Evidence includes:

| Phase | What's recorded |
|---|---|
| RED | Test files changed, test command, exit code (must be non-zero), timestamp |
| GREEN | Test command, exit code (must be 0), timestamp |
| REFACTOR | Test command, exit code (must be 0), timestamp |

**RED load-failure rejection (GH-532):** `record-red` rejects test runs whose
captured output matches a load-failure signature instead of an assertion
failure: `ReferenceError:`, `SyntaxError:`, `Cannot find module` /
`MODULE_NOT_FOUND`, or a runner reporting zero tests (`# tests 0`, anchored
to the TAP summary line). A crashing test exits non-zero but verifies nothing —
accepting it as RED wedges the subsequent GREEN (the same crash repeats
regardless of source edits). Stack-frame lines (`  at …`) and lines inside a
reported test's `details:` block are ignored, so `assert.throws(ReferenceError)`
remains a valid RED. **Recovery is NOT a bypass:** fix the test file so it
loads cleanly and produces a real assertion failure, then re-run `record-red`.
Each rejection appends a `tdd-red-load-failure-rejected` row to
`.work-actions.json` via `appendEnforcementAudit`
(`allow: false`, `meta: { cycle, testCommand, signature, snippet }`).

**Hang rejection (GH-584):** a timed-out test run is a hang, not an assertion
failure. `runTestCommandWithOutput` (`tdd-phase-state/io.js`) returns
`timedOut: true` and puts the timeout diagnostic into the captured stderr;
`record-red` rejects it as RED (audit row `tdd-red-hang-rejected`) and
`record-green`/`record-refactor` reject it as a pass. A hanging command
usually means a watch-mode/interactive command in the `### Test Strategy` —
a planner defect: the agent must STOP and report
`BLOCKED (planner-defect): …`, never edit tasks.md. The implement gate turns
pre-/post-implement hangs into a `plannerDefect` retry (operator-hold)
instead of re-running the hanging command forever.

**Machine-verified escape paths** (never trusted free text, always audited):
- `record-resume-completed` / `task-next.js --resume-completed` (GH-509):
  records a complete cycle for work already committed in a prior interrupted
  session, ONLY when all four conditions verify from git/fs — no COMPLETED
  cycles (a stale red-only record from an interrupted session is superseded
  and noted in the audit meta), in-scope test files with test blocks on
  disk, a passing command, and branch commits touching the task's scope.
  The recorder also verifies the supplied `--cmd` against the
  strategy-resolved command (shared `resolveTaskTestExecution`) — it never
  trusts the caller's command. Audit row `tdd-resume-completed`.
- `red-mode: ablation` (GH-570, planner-declared in the Test Strategy, legal
  only for kinds `unit`/`integration`/`e2e`/`custom`): RED is produced by a
  temporary IN-SCOPE source mutation (recorded with `mutationSha`; in-scope
  test files with it()/test() blocks are required and content-pinned via
  `testFileStateSha`; failing test names land in `failingTest`,
  best-effort), GREEN verifies the revert (`revertSha`) and that the test
  files are byte-identical to their RED state. Audit row
  `tdd-ablation-cycle` carries both shas. During RED, the
  `work-implement-enforce.js` file gate permits in-scope source edits for
  ablation-declared tasks (audited `ABLATION_RED_SOURCE_EDIT`) so the
  mutation itself is not blocked.
- `record-skip-red` (tests-only contract): RED intentionally skipped for
  `### Type: tests-only` tasks, with a required `--reason`.

**Gate-captured evidence:** when the implement gate itself runs the task
command (pre-/post-implement verification), it writes through the shared
`tdd-phase-state/gate-writer.js` module — atomic tmp+rename writes, the same
load-failure and hang rejections as the recorder, and the same RC-D
empty-output GREEN rejection (an exit-0 run with zero stdout/stderr is
refused and audited as `tdd-green-empty-rejected` for Types whose
`gateContractFor(taskType).rcdEmptyTrap` is true; docs-exempt-equivalent
kinds — docs / config / ci / file-move / checkpoint — stay exempt), plus
`capturedByGate: true` stamps. The `WORK_SKIP_E2E` stub path also writes
through it and appends a `tdd-e2e-skip-stub` audit row so the fabricated
cycle is visible in `.work-actions.json`.

**Token gating:** Gated subcommands (`record-red`, `record-skip-red`, `record-green`, `record-refactor`, `record-resume-completed`, `transition`, `exception`) require a token issued by `enforce-step-workflow.js` Rule 5. This prevents unauthorized evidence injection.

**Authorized agents:** `developer-nodejs-tdd`, `developer-react-senior`, `developer-react-ui-architect`, `developer-devops`

### Layer 4: Evidence Validation (Orchestrator)

**File:** `scripts/workflows/work/lib/tdd-enforcement.js`

The `/work` orchestrator (and the stop hook) validate TDD evidence via the ONE shared contract-aware validator `validateTddEvidenceForType(evidence, taskType)` before allowing transition out of `implement`. The SAME function is consumed by the implement gate (`evidence-flow.js`), `check-gate.js` (`per-task-tdd-evidence`), `workflow-definition.js verifyPerTaskTDD` (check/complete verifies), and `mark-task-progress.js` — one implementation, no parallel copies, so evidence the gate advances on can never dead-end downstream. Evidence is valid when any of these holds:

- **TDD-exempt Type** — the task's `### Type` is in `task-types.js TDD_EXEMPT_TYPES` and at least one cycle carries `red` OR `green` evidence (stub or real — the gate's non-TDD pre-test stub is a complete record for exempt Types). Unknown/missing Types validate strictly (fail closed).
- **Exception** — legacy bare-string reason, or the structured `{ category, reason }` shape where `category` is validated against `exception-validator.js ALLOWED_CATEGORIES` (the shared `TDD_EXEMPT_TYPES` enum plus the `config-only` legacy alias) and `reason` is non-empty.
- **A complete cycle** — at least one cycle with both `red` and `green` evidence (REFACTOR recommended but optional).
- **A citation cycle** — a green-only cycle whose `green.kind` is `verified-by` or `wiring-citation` (written by the recorder's peer-citation path). `peerSha` MUST be present — citation evidence without peer provenance is rejected, not treated as incomplete.

## Phase Transitions

**File:** `scripts/workflows/work-implement/tdd-phase-registry.js`

Valid transitions:

```
red → green → refactor → red (cyclic)
```

`exception` is not part of the transition graph — it is set directly by the `cmdException()` function, bypassing `tddCanTransition()`. It overwrites the entire state file with `{ currentPhase: 'exception', exception: { category, reason }, cycles: [] }`.

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
  "exception": {
    "category": "config",
    "reason": "config-only change, no testable behavior"
  },
  "cycles": []
}
```

(Legacy bare-string `"exception": "<reason>"` recordings are still accepted by `validateTddEvidence` for backward compatibility.)

## Exception Mode (Operator-Only)

The `exception` subcommand is an operator-only escape hatch: it requires `WORK_OPERATOR_TOKEN=1`, which agent environments never carry. Agents get TDD exemptions exclusively from the planner's `### Type` taxonomy — never by invoking `exception`.

**Categories** (`exception-validator.js ALLOWED_CATEGORIES`, built from the shared `TDD_EXEMPT_TYPES` enum in `skills/split-in-tasks/lib/task-types.js` so the two can never drift): `tests-only`, `docs`, `config`, `ci`, `mechanical-refactor`, `file-move`, `checkpoint`, plus `config-only` as a legacy alias for `config`.

**Guards:**
- `--category` and a non-empty `--reason` are required; unknown categories are rejected (GH-258 closed).
- `checkpoint` requires `--task <N>` and verifies the task really is a checkpoint task in tasks.md.
- Rejected when any changed/staged/untracked source file contains exports (`checkNewExportedCode`) — new exported code requires TDD.
- Every invocation — allowed or rejected — appends a `tdd-exception` enforcement row to `.work-actions.json`.

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

When the `/work` orchestrator transitions to the `implement` step, it automatically initializes `tdd-phase.json` with RED phase:

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
# Agent entrypoint in multi-task mode (resolves the command from ### Test Strategy)
node task-next.js TICKET-123 task3
node task-next.js TICKET-123 task3 --resume-completed   # machine-verified resume (GH-509)

# Initialize
node tdd-phase-state.js init TICKET-123 [--task N]

# Check current phase
node tdd-phase-state.js current TICKET-123 [--task N]

# Record phases (runs test command internally)
node tdd-phase-state.js record-red TICKET-123 --cmd "npm test" [--task N]
node tdd-phase-state.js record-green TICKET-123 --cmd "npm test" [--task N]
node tdd-phase-state.js record-refactor TICKET-123 --cmd "npm test" [--task N]

# tests-only contract: RED intentionally skipped
node tdd-phase-state.js record-skip-red TICKET-123 --reason "why" [--task N]

# Machine-verified resume recording (normally reached via task-next.js --resume-completed)
node tdd-phase-state.js record-resume-completed TICKET-123 --task N --cmd "npm test"

# Manual transition
node tdd-phase-state.js transition TICKET-123 green [--task N]

# Exception mode (operator-only; requires WORK_OPERATOR_TOKEN=1)
node tdd-phase-state.js exception TICKET-123 --category <category> --reason "reason" [--task N]
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `WORK_TDD_TOKEN_SKIP` | `0` | Skip token verification (debugging) |
| `WORK_OPERATOR_TOKEN` | unset | Required (`=1`) for the operator-only `exception` subcommand |
| `WORK_SKIP_E2E` | unset | Implement-gate skips E2E commands; stub evidence audited as `tdd-e2e-skip-stub` |
| `TDD_PHASE_TEST_TIMEOUT_MS` | `300000` | Recorder test-run timeout (a timed-out run is rejected as a hang) |
| `TASK_NEXT_TEST_TIMEOUT_MS` | `300000` | task-next.js test-run timeout |
| `TASKS_BASE` | from config | State file root |
| `ENFORCE_HOOK_DEBUG` | `0` | Verbose hook logging |

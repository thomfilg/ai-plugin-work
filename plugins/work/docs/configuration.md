# Configuration

The plugin uses environment variables for configuration, resolved through `scripts/workflows/lib/config.js` from the repo `.env` file or the current process environment (e.g., populated by `direnv` from `.envrc`).

## Environment Variables

### Required

| Variable | Example | Purpose |
|---|---|---|
| `TICKET_PROJECT_KEY` | `PROJ` | Ticket ID prefix (e.g., PROJ-123) |
| `REPO_NAME` | `my-app` | Repository name (used for worktree folder naming) |
| `TASKS_BASE` | `../tasks` | Root directory for task state and artifacts |

### Recommended

| Variable | Example | Purpose |
|---|---|---|
| `WORKTREES_BASE` | `..` | Parent directory for git worktrees |
| `BASE_BRANCH` | `main` | Git base branch (auto-detected: main/dev/master) |
| `TICKET_PROVIDER` | `jira` | Ticket provider: `jira`, `linear`, `github`, `none` |
| `WEB_APPS` | `[{"name":"web","appType":"web"}]` | JSON array of app configs for QA routing |

### Ticket Provider Configuration

#### Jira
| Variable | Example |
|---|---|
| `JIRA_PROJECT_KEY` | `PROJ` |
| `JIRA_BASE_URL` | `your-org.atlassian.net` |

#### Linear
| Variable | Example |
|---|---|
| `LINEAR_TEAM_KEY` | `ENG` |

#### GitHub
| Variable | Example |
|---|---|
| `GITHUB_ORG` | `my-org` |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `DEV_COMMAND` | (auto-detect) | Custom dev server start command |
| `TEST_COMMAND` | (auto-detect) | Legacy single test runner (prefer `TEST_*_COMMAND` below) |
| `LINT_COMMAND` | (auto-detect) | Custom linter command. Use `$CHANGED_FILES` placeholder for scoped runs. Example: `pnpm lint $CHANGED_FILES` |
| `TYPECHECK_COMMAND` | (auto-detect) | Custom typecheck command. Use `$CHANGED_FILES` placeholder for scoped runs. Example: `pnpm typecheck $CHANGED_FILES` |
| `TEST_UNIT_COMMAND` | | Per-suite scoped test command for **dev** (use `$CHANGED_FILES`). Example: `pnpm test $CHANGED_FILES` |
| `TEST_INTEGRATION_COMMAND` | | Per-suite scoped integration test command for **dev** |
| `TEST_E2E_COMMAND` | | Per-suite scoped e2e test command for **dev** |
| `SCRIPT_RUN_AFFECTED_UNIT` | | Affected-suite script for **/check** (computes affected internally). Example: `pnpm exec tsx ./scripts/run-affected-tests.ts --unit`. Additionally receives `IMPACT_TEST_FILES` (newline-separated test files that import a changed source file — one hop) and `IMPACT_TEST_FILES_BASE` in its environment, so api-contract changes that break consumer-test mocks run those tests too (echo-5820) |
| `SCRIPT_RUN_AFFECTED_INTEGRATION` | | Affected-suite script for **/check** |
| `SCRIPT_RUN_AFFECTED_E2E` | | Affected-suite script for **/check**. Receives `CHANGED_SPECS` (newline-separated, strictly-changed spec files + specs importing a changed helper), `CHANGED_SPECS_BASE`, and `E2E_PER_SPEC_TIMEOUT_MS` in its environment |
| `CHECK_FLAKE_RETRY` | `1` | Set to `0` to disable the /check single flake-retry round on small/transient test failures |
| `CHECK_FLAKE_RETRY_MAX` | `5` | Max failing tests for a run to qualify for the flake retry (transient signatures always qualify) |
| `CHECK_TESTS_BASELINE` | `1` | Set to `0` to disable the `tests-baseline.json` net-new vs pre-existing failure split in /check (the baseline file lives in the ticket tasks dir, next to `.check-state.json`) |
| `SCRIPT_TYPECHECK_COMMAND` | | Full-repo typecheck command for the **/check** typecheck-error delta (echo-5137-issue-4). Example: `pnpm exec tsc --noEmit`. Unlike `TYPECHECK_COMMAND` (dev, `$CHANGED_FILES`-scoped), this runs the whole project so inherited base-branch errors can be split from yours: output is parsed into stable keys (file + TS code + message prefix; line numbers excluded) and diffed against a per-ticket `typecheck-baseline.json` in the ticket tasks dir. Net-new errors fail `4_run_tests` with the per-key list; pre-existing errors are reported as "not yours" and never block. Validated through the safe-env-command allowlist — unsafe values are ignored, never executed. Unset → the delta is silently skipped |
| `CHECK_TYPECHECK_BASELINE` | `1` | Set to `0` to disable the /check typecheck-error delta entirely (no typecheck run, no baseline read/write) even when `SCRIPT_TYPECHECK_COMMAND` is set. The baseline is captured on the first classified run for the ticket (those errors report as pre-existing, never "clean") and ratchets down whenever a run has zero net-new errors. Limitation: the net-new signal only discriminates from the second run onward — errors already on the branch at first capture are recorded as pre-existing, not attributed to the branch |
| `CHECK_E2E_SPEC_TIMEOUT_MS` | `60000` | Per-spec time budget exported to the e2e suite as `E2E_PER_SPEC_TIMEOUT_MS` (30s is too tight under `--repeat-each --workers=1`) |
| `CHECK_IMPACT_TESTS` | `1` | Set to `0` to disable /check impact-aware unit-test selection (the one-hop `IMPACT_TEST_FILES` set of test files importing a changed source file, exported to `SCRIPT_RUN_AFFECTED_UNIT`) |
| `CHECK_GHERKIN_SCOPE` | `1` | Set to `0` to disable the /check `4b_gherkin_scope` step (declared Gherkin scope in spec.md vs actual committed diff) — the step auto-passes with a SKIPPED note in `gherkin-scope.check.md` |
| `CHECK_GHERKIN_COVERAGE` | warn | Static Gherkin-to-test coverage inside `4b_gherkin_scope`: each spec.md scenario name is keyword-matched against `it`/`test`/`describe` descriptions in the diff's test files (manual override: `<!-- gherkin-covered: scenario name → test-file.js:line -->` in spec.md). Unset/default → uncovered scenarios add a WARNING to `gherkin-scope.check.md`; `strict` → uncovered scenarios fail the step; `0` → disabled. Missing spec.md or zero scenarios always skip silently |
| `SESSION_GUARD_ENABLED` | `1` | Prevent concurrent /work sessions |
| `TASK_REVIEW_MAX_FIXES` | `2` | Max fix rounds per task review |
| `READ_DOCS_ON_BRIEF` | | Paths to docs the brief-writer should read |
| `READ_DOCS_ON_SPEC` | | Paths to docs the spec-writer should read |
| `WORK_SKIP_E2E` | | Set to `1` to make implement-gate skip executing E2E test commands. Detected E2E patterns (`pnpm e2e`, `playwright`, `$TEST_E2E_COMMAND`) get skip-stub evidence so the workflow advances without spending minutes on browser tests. Each stub is written via the shared gate-writer and audited to `.work-actions.json` as `tdd-e2e-skip-stub` so the fabricated cycle stays visible. Alias: `WORK_SKIP_E2E_TESTS=1`. |
| `WORK_OPERATOR_TOKEN` | | Set to `1` to enable the operator-only `tdd-phase-state.js exception` subcommand. Agent environments never carry it. |

### Debug Variables

| Variable | Default | Purpose |
|---|---|---|
| `ENFORCE_HOOK_DEBUG` | `0` | Verbose hook logging to stderr |
| `WORK_TDD_TOKEN_SKIP` | `0` | Skip TDD token verification |
| `HOOK_ERROR_LOG` | `/tmp/claude-hook-errors.log` | Hook error log path |

## Config Resolution

**File:** `scripts/workflows/lib/config.js`

Resolution order (first wins):
1. `process.env` (command line / shell environment — includes variables loaded by `direnv` from `.envrc`)
2. `.env` file (repo root or cwd — loaded by `config.js`)
3. Defaults in `config.js`

### Key Functions

```javascript
const config = require('./config');

config.TASKS_BASE           // Resolved tasks directory
config.WORKTREES_BASE       // Resolved worktrees directory
config.safeTicketId(id)     // Sanitize ticket ID for filesystem
config.getBaseBranch()      // Detect base branch
config.tasksDir(ticketId)   // Full path to ticket's tasks dir
config.repoDir()            // Current repo root
config.worktreeDir(ticket)  // Worktree path for a ticket
config.prefixTicketId(id)   // Add project key prefix if missing
```

## Ticket Provider

**File:** `scripts/workflows/lib/ticket-provider.js`

The provider abstraction handles differences between Jira, Linear, and GitHub:

| Provider | ID Format | Path Sanitization | URL Format |
|---|---|---|---|
| `jira` | `PROJ-123` | (none) | `https://org.atlassian.net/browse/PROJ-123` |
| `linear` | `ENG-123` | (none) | `https://linear.app/team/ENG-123` |
| `github` | `#123` | `#123` → `GH-123` | `https://github.com/org/repo/issues/123` |
| `none` | any | (none) | (none) |

### Provider Resolution

Provider resolution uses this precedence:
1. If `TICKET_PROVIDER` env var is set → use it directly
2. Per-repo config in `~/.claude/ticket-providers.json` (if exists)
3. Fallback based on available env vars (e.g., `JIRA_PROJECT_KEY`)
4. Otherwise → `none`

## WEB_APPS Configuration

The `WEB_APPS` variable controls QA agent routing during `/check`:

```json
[
  {
    "name": "web",
    "appType": "web",
    "port": 3000,
    "startCommand": "pnpm dev",
    "paths": ["src/app", "src/components"]
  },
  {
    "name": "api",
    "appType": "api",
    "paths": ["src/server", "src/routes"]
  }
]
```

| Field | Required | Purpose |
|---|---|---|
| `name` | Yes | App identifier (used in report filenames) |
| `appType` | Yes | `web` (Playwright), `api` (HTTP), `cli` (skip QA) |
| `port` | No | Dev server port |
| `startCommand` | No | Custom start command |
| `paths` | No | Source paths to match against git diff for impact detection |

## .envrc Location

In many setups, especially when using `direnv`, the `.envrc` file lives in the **parent directory** relative to the worktree rather than inside the worktree itself. This is a shell/environment convention (direnv loads `.envrc` into `process.env`), not a special `../` lookup implemented by `config.js`.

```
parent-dir/
├── .envrc                    ← Config lives here
├── tasks/                    ← TASKS_BASE
├── my-repo/                  ← Main repo
└── my-repo-TICKET-123/       ← Worktree
```

## Path Security

**File:** `scripts/workflows/lib/ticket-validation.js`

All ticket-ID-to-path conversions are validated:

1. **Traversal prevention:** Rejects `..`, `\`, null bytes
2. **Containment check:** Resolved path must stay within `TASKS_BASE`
3. **Post-sanitization validation:** Re-validates after `#123 → GH-123` transform

```javascript
validateTicketId(ticketId)              // Throws on invalid
sanitizeTicketId(ticketId)              // Transform for filesystem
assertPathContainment(path, base, ctx)  // Verify path stays within base
```

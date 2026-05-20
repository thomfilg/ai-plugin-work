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
| `SCRIPT_RUN_AFFECTED_UNIT` | | Affected-suite script for **/check2** (computes affected internally). Example: `pnpm exec tsx ./scripts/run-affected-tests.ts --unit` |
| `SCRIPT_RUN_AFFECTED_INTEGRATION` | | Affected-suite script for **/check2** |
| `SCRIPT_RUN_AFFECTED_E2E` | | Affected-suite script for **/check2** |
| `SESSION_GUARD_ENABLED` | `1` | Prevent concurrent /work2 sessions |
| `TASK_REVIEW_MAX_FIXES` | `2` | Max fix rounds per task review |
| `READ_DOCS_ON_BRIEF` | | Paths to docs the brief-writer should read |
| `READ_DOCS_ON_SPEC` | | Paths to docs the spec-writer should read |
| `WORK_SKIP_E2E` | | Set to `1` to make implement-gate skip executing E2E test commands. Detected E2E patterns (`pnpm e2e`, `playwright`, `$TEST_E2E_COMMAND`) get skip-stub evidence so the workflow advances without spending minutes on browser tests. Alias: `WORK_SKIP_E2E_TESTS=1`. |

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

The `WEB_APPS` variable controls QA agent routing during `/check2`:

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

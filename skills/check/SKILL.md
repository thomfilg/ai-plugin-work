---
name: check
argument-hint: ticket-id
description: Run full quality check - QA testing, code review, and requirements verification in parallel
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite, Skill, AskUserQuestion, mcp__atlassian__jira_get_issue, mcp__linear__get_issue, mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_click, mcp__playwright__browser_type, mcp__playwright__browser_fill_form, mcp__playwright__browser_take_screenshot
---

# /check - Full Quality Check (Workflow Engine)

Run all verification agents in parallel: quality-checker (lint, typecheck, tests), code-checker, qa-feature-tester, and completion-checker. After code review, the appropriate developer agent(s) evaluate suggestions and create code-review-reply.check.md.

**Developer Selection:** Based on changed files, the system dynamically selects:
- `developer-nodejs-tdd` for backend/API changes
- `developer-react-senior` for frontend/UI changes
- `developer-devops` for infrastructure changes

**Consensus Flow:** When code-checker makes suggestions (🟡 or 🟢):
1. Developer(s) evaluate and decide: IMPLEMENTED | DEFERRED | NOT_APPLICABLE
2. Code-checker validates developers' decisions (AGREE | DISAGREE)
3. If ALL parties agree → consensus complete
4. If ANY party disagrees → consensus loop until agreement or escalation

## Arguments

- `$ARGUMENTS` - Optional ticket ID (e.g., PROJ-123)
- If not provided, will check current changes without ticket context

---

## Workflow Engine Integration

This command uses the workflow engine for resumability and skip detection.

### Step 0: Generate Plan

```bash
PLAN_JSON=$(node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check plan "$ARGUMENTS")
echo "$PLAN_JSON"
```

Parse the plan JSON to get:
- `instanceId` — ticket ID or branch name
- `plan` — array of steps with action (RUN/SKIP) and reason
- `summary` — counts of RUN/SKIP steps, stepsToRun list

**If `summary.run === 0` or only `8_output` runs:** The cache is valid. Display the cached README.md from the report folder and EXIT early.

**Otherwise:** Execute each RUN step in order, calling `transition` before each.

### Transition Command

Before starting each step, call:
```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition <instanceId> <step_id>
```

---

## Shared Instructions (Referenced by Agents)

**FORBIDDEN_COMMANDS** - Full workspace commands that ONLY quality-checker should run:
```
pnpm lint, pnpm typecheck, pnpm test, pnpm build
pnpm affected:lint, pnpm affected:typecheck, pnpm affected:test
make dev-local, pnpm dev (services already running)
```

**ALLOWED for agents during development** - Quick checks on changed files only (3-tier fallback):
```
# Tier 1: Project defines dev:check
pnpm dev:check     # Runs: dev:lint → dev:typecheck → dev:test

# Tier 2: Bundled dev-check scripts (if project has no dev:check)
${CLAUDE_PLUGIN_ROOT}/scripts/dev-check/dev-check.sh

# Tier 3: Standard scripts (last resort)
pnpm lint && pnpm typecheck && pnpm test

# Individual scripts (if project defines them):
pnpm dev:lint      # Lint only changed JS/TS files
pnpm dev:typecheck # Typecheck only changed TS files
pnpm dev:test      # Unit tests for changed files (excludes smoke/e2e)
```

**REPORT_HEADER** - Every report MUST start with:
```
**Changes Hash:** ${CHANGES_HASH}
```

---

## Step 1_setup: Setup and Cache Check

Run the setup script to initialize variables and check cache:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 1_setup
SETUP_RESULT=$(node ${CLAUDE_PLUGIN_ROOT}/hooks/check-setup.js "$ARGUMENTS")
echo "$SETUP_RESULT"
```

Parse the JSON output to get:
- `MAIN_WORKTREE_PATH` - Path to main worktree
- `REPORT_FOLDER` - Where to save reports
- `CHANGES_HASH` - Hash for cache validation
- `TICKET_ID` - From `ticketId` field in setup JSON output
- `IMPACTED_APPS` - Array of changed apps
- `AFFECTED_FILES` - Object with `apps` (files per app) and `packages` (changed packages)
- `REVIEW_DOCS` - Project-specific review docs (from `READ_DOCS_ON_REVIEW`)
- `QA_DOCS` - Project-specific QA docs (from `READ_DOCS_ON_QA`)
- `DEV_DOCS` - Project-specific dev docs (from `READ_DOCS_ON_DEV`)
- `E2E_DOCS` - Project-specific E2E testing docs (from `READ_DOCS_ON_E2E`)
- `TEST_DOCS` - Project-specific unit testing docs (from `READ_DOCS_ON_TEST`, used by tests-review/tests-create skills)
- `cache.cached` - Whether reports are up-to-date

**If `cache.cached` is true:**
```
╔══════════════════════════════════════════════════════════════════════╗
║  ✅ REPORTS UP-TO-DATE - SKIPPING CHECKS                             ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  Changes Hash: ${CHANGES_HASH} (unchanged)                           ║
║  Reports folder: ${REPORT_FOLDER}                                    ║
║                                                                      ║
║  No code changes since last /check run.                              ║
║  Displaying cached results...                                        ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
```
Transition directly to `8_output`: `node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 8_output`
Display the cached README.md and then transition to `9_cleanup` and EXIT.

**If `cache.cached` is false:** Continue with Step 2_start_env.

---

## Step 2_start_env: Start Dev Environment (DYNAMIC PORTS)

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 2_start_env
ENV_RESULT=$(node ${CLAUDE_PLUGIN_ROOT}/hooks/check-start-env.js '${JSON.stringify(IMPACTED_APPS)}')
RUNNING_APPS=$(echo "$ENV_RESULT" | jq '.runningApps')
echo "Running apps: $RUNNING_APPS"
```

**Example output:**
```json
{
  "status-site": { "port": 5175, "url": "http://host.docker.internal:5175", "pid": 12345 },
  "as-dashboard": { "port": 5178, "url": "http://host.docker.internal:5178", "pid": 12346 }
}
```

⚠️ **CRITICAL:** Ports are NOT guaranteed to match defaults. Always use the values returned by `check-start-env.js`.

**Default ports (reference only - actual ports may differ):**
```
as-dashboard:       5173 (default, may vary)
as-dashboard-admin: 5174 (default, may vary)
status-site:        5175 (default, may vary)
status-site-admin:  5176 (default, may vary)
```

**Database env (shared across all agents):**
```
DB_ENV = {
  DATABASE_HOST: "localhost",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "status-site",
  DATABASE_MASTER_USER_NAME: "postgres",
  DATABASE_MASTER_PASSWORD: "mypassword"
}
```

## Step 3_verify_playwright: Verify Playwright (FAIL FAST)

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 3_verify_playwright
```

**Before launching QA agents**, verify Playwright works:

```bash
# Quick connectivity check
mcp__playwright__browser_navigate(url: "https://www.google.com")
```

```
╔══════════════════════════════════════════════════════════════════════╗
║  IF PLAYWRIGHT FAILS HERE:                                           ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  🛑 STOP - Do NOT launch QA agents                                   ║
║                                                                      ║
║  1. Try: node scripts/mcp-wrapper.js playwright                      ║
║  2. Check output for errors                                          ║
║  3. Report INFRASTRUCTURE_FAILURE                                    ║
║                                                                      ║
║  Transition to 8_output with error status.                           ║
║  QA agents will waste time if Playwright is broken.                  ║
║  Fix infrastructure first, then re-run /check.                       ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
```

**If Playwright fails:** This is a BLOCKING error. Do NOT skip QA. Report INFRASTRUCTURE_FAILURE and transition to `8_output`: `node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 8_output`
The /check result MUST show NEEDS_WORK with infrastructure failure — QA cannot be skipped.
**If Playwright works:** Continue to Step 4_phase1_agents.

---

## Step 4_phase1_agents: Launch Phase 1 Agents (PARALLEL)

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 4_phase1_agents
```

Launch agents in **parallel**:
- code-checker (creates code-review.check.md - suggestions only)
- quality-checker (creates tests.check.md)
- qa-feature-tester (creates qa-*.check.md) - one per impacted app
- qa-api-tester (creates qa-api.check.md) - if backend changes
- completion-checker (creates completion.check.md)

**Pass these variables to ALL agents:**
- `REPORT_FOLDER` - From Step 1_setup
- `CHANGES_HASH` - From Step 1_setup
- `AFFECTED_FILES` - From Step 1_setup (for QA agents)
- `RUNNING_APPS` - From Step 2_start_env
- `DB_ENV` - Database env vars from Step 2_start_env

**Agent Timeouts:**
| Agent | Max Time | On Timeout |
|-------|----------|------------|
| code-checker | 5 min | Mark TIMEOUT, continue |
| quality-checker | 15 min | Mark TIMEOUT, continue |
| qa-feature-tester | 10 min/app | Mark TIMEOUT, continue |
| qa-api-tester | 10 min | Mark TIMEOUT, continue |
| completion-checker | 5 min | Mark TIMEOUT, continue |

If agent exceeds timeout → report shows TIMEOUT status, other agents continue.

### Agent 1: code-checker

```
Review all recent changes in the current working directory.

REPORT_FOLDER: ${REPORT_FOLDER}
CHANGES_HASH: ${CHANGES_HASH}

${REVIEW_DOCS ? `
## Project-Specific Review Rules

IMPORTANT: Apply these project-specific rules as PRIMARY review criteria.
Flag violations of these rules with higher priority than generic best practices.

${REVIEW_DOCS}
` : ''}

🚫 See FORBIDDEN_COMMANDS above (quality-checker handles those)

✅ YOUR JOB - READ and ANALYZE code only:
- git diff to see changes
- Read tool to examine files
- Grep/Glob to search codebase

Focus on: Code quality, bugs, security, performance

Report format with severity levels:
- 🔴 CRITICAL (must fix)
- 🟡 IMPORTANT (should fix)
- 🟢 SUGGESTION (nice to have)

📁 Save to: ${REPORT_FOLDER}/code-review.check.md
⚠️ Start with REPORT_HEADER
```

### Agent 2: quality-checker

```
Run lint, typecheck, and automated tests.

REPORT_FOLDER: ${REPORT_FOLDER}
CHANGES_HASH: ${CHANGES_HASH}
RUNNING_APPS: ${JSON.stringify(RUNNING_APPS)}

⚠️ RUNNING_APPS contains dynamically assigned ports - do NOT use hardcoded ports.
DB_ENV: ${JSON.stringify(DB_ENV)}

⚠️ YOU ARE THE ONLY AGENT that runs lint/typecheck/tests.

🖥️ SERVER STATUS: Database and apps are ALREADY RUNNING.
- Database: PostgreSQL on localhost:5432
- Apps: ${JSON.stringify(RUNNING_APPS)}

⚠️ For integration/smoke tests, use these env vars:
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=status-site
DATABASE_MASTER_USER_NAME=postgres
DATABASE_MASTER_PASSWORD=mypassword

Commands to run (use LOW_CONCURRENCY=1):
1. LOW_CONCURRENCY=1 pnpm affected:lint
2. LOW_CONCURRENCY=1 pnpm affected:typecheck
3. LOW_CONCURRENCY=1 pnpm affected:test
4. pnpm dev:integration <app> (preferred - auto-maps DB env vars; fallback: LOW_CONCURRENCY=1 pnpm affected:test:integration with DB_ENV vars)
5. pnpm dev:smoke <app> (preferred - auto-maps DB env vars; fallback: LOW_CONCURRENCY=1 pnpm affected:test:smoke:ci with DB_ENV vars)

⚠️ Note: Ensure test runners (Vitest/Jest) use --poolOptions.threads.singleThread
   to prevent spawning parallel workers when LOW_CONCURRENCY=1 is set.

📁 Save to: ${REPORT_FOLDER}/tests.check.md

⚠️ FIRST LINE MUST BE: **Changes Hash:** ${CHANGES_HASH}

Status: APPROVED (all pass) or NEEDS_WORK (any failures)
```

### Agent 3.x: QA Testing (MANDATORY — one per impacted app)

**QA is NOT optional.** Use `/check-qa` command for each app in IMPACTED_APPS, ALL IN PARALLEL.
When only packages are changed (no direct app changes), `IMPACTED_APPS` automatically includes all web apps defined in the repo's `WEB_APPS` config. If `IMPACTED_APPS` is still empty after detection, report a configuration error — the repo may need a `WEB_APPS` entry in its `.env`.

For each app in `IMPACTED_APPS`, invoke the `/check-qa` skill with JSON parameters:

```javascript
// For each APP_NAME in IMPACTED_APPS:
const qaParams = {
  ticketId: TICKET_ID,
  reportPath: `${REPORT_FOLDER}/qa-${APP_NAME}.check.md`,
  changesHash: CHANGES_HASH,
  appUrl: RUNNING_APPS[APP_NAME].url,
  screenshotsFolder: `${REPORT_FOLDER}/screenshots/${APP_NAME}/`,
  affectedFiles: AFFECTED_FILES.apps[APP_NAME] || [],
  affectedPackages: AFFECTED_FILES.packages || [],
  qaDocs: QA_DOCS || '',  // Project-specific QA docs from READ_DOCS_ON_QA
  e2eDocs: E2E_DOCS || ''  // E2E docs extracted from check-setup JSON output field 'e2eDocs' (READ_DOCS_ON_E2E)
};

// Invoke skill:
Skill("check-qa", args: `${APP_NAME} ${JSON.stringify(qaParams)}`)
```

**Example invocations (run in parallel):**

```
# For status-site
Skill("check-qa", args: "status-site {\"ticketId\":\"PROJ-856\",\"reportPath\":\"${HOME}/worktrees/tasks/PROJ-856/qa-status-site.check.md\",\"changesHash\":\"e44af95d\",\"appUrl\":\"http://host.docker.internal:5175\",\"screenshotsFolder\":\"${HOME}/worktrees/tasks/PROJ-856/screenshots/status-site/\",\"affectedFiles\":[],\"affectedPackages\":[\"@$REPO_NAME/ui\"]}")

# For as-dashboard
Skill("check-qa", args: "as-dashboard {\"ticketId\":\"PROJ-856\",\"reportPath\":\"${HOME}/worktrees/tasks/PROJ-856/qa-as-dashboard.check.md\",\"changesHash\":\"e44af95d\",\"appUrl\":\"http://host.docker.internal:5178\",\"screenshotsFolder\":\"${HOME}/worktrees/tasks/PROJ-856/screenshots/as-dashboard/\",\"affectedFiles\":[\"apps/as-dashboard/src/EmailPreview.tsx\"],\"affectedPackages\":[]}")
```

**What /check-qa does:**
1. Creates screenshots folder
2. Verifies Playwright MCP availability
3. Launches qa-feature-tester agent with context
4. Validates report was created with required sections

**Enforcement:** SubagentStop hook validates QA reports (see `${CLAUDE_PLUGIN_ROOT}/hooks/validate-qa-report.js`)

### Agent 3.5: API Testing (CONDITIONAL - only if backend changes)

**First, detect if there are backend/API changes:**

```javascript
// Check AFFECTED_FILES for backend patterns
function hasBackendChanges(affectedFiles) {
  const backendPatterns = [
    /worker\//,           // Worker apps
    /src\/routes\//,      // API routes
    /src\/api\//,         // API handlers
    /src\/services\//,    // Backend services
    /src\/controllers\//,  // Controllers
    /src\/middleware\//,  // Middleware
    /\.sql$/,             // SQL files
    /migrations\//,       // Database migrations
  ];

  // Check app files
  for (const [appName, files] of Object.entries(affectedFiles.apps || {})) {
    // Worker apps are always backend
    if (appName.includes('worker')) return true;

    // Check files for backend patterns
    for (const file of files) {
      if (backendPatterns.some(pattern => pattern.test(file))) {
        return true;
      }
    }
  }

  // Check package files for backend packages
  const backendPackages = ['database', 'queue', 'api-client', 'shared-backend'];
  for (const pkgFile of affectedFiles.packages || []) {
    if (backendPackages.some(pkg => pkgFile.includes(`packages/${pkg}/`))) {
      return true;
    }
  }

  return false;
}
```

**If `hasBackendChanges(AFFECTED_FILES)` returns true:**

Launch `qa-api-tester` agent for API testing:

```
Test backend APIs affected by the changes.

REPORT_FOLDER: ${REPORT_FOLDER}
CHANGES_HASH: ${CHANGES_HASH}
TICKET_ID: ${TICKET_ID}
AFFECTED_FILES: ${JSON.stringify(AFFECTED_FILES)}
DB_ENV: ${JSON.stringify(DB_ENV)}

${QA_DOCS ? `
## Project-Specific QA Rules

IMPORTANT: Apply these project-specific QA rules as PRIMARY testing criteria.

${QA_DOCS}
` : ''}

Focus on:
1. Changed API endpoints (routes/controllers)
2. Modified service logic
3. Database operations affected by migrations
4. Worker job processing (if worker changes)

Test using:
- curl for API endpoints
- Database queries to verify data state
- Health checks for services

📁 Save to: ${REPORT_FOLDER}/qa-api.check.md
⚠️ Start with: **Changes Hash:** ${CHANGES_HASH}

Status: APPROVED (all pass) or NEEDS_WORK (any failures)
```

**If `hasBackendChanges(AFFECTED_FILES)` returns false:**
Skip API testing. Add note to summary: "API testing skipped - no backend changes detected"

### Agent 4: completion-checker

```
Verify all requirements have been delivered.

REPORT_FOLDER: ${REPORT_FOLDER}
CHANGES_HASH: ${CHANGES_HASH}
TICKET_ID: ${TICKET_ID}

🚫 See FORBIDDEN_COMMANDS above

---

## Step 0: Find the correct source for changes

⚠️ **CRITICAL: Check the CORRECT SOURCE!**

╔══════════════════════════════════════════════════════════════════════╗
║  🛑 NEVER just grep local files on main branch!                      ║
║     Changes aren't merged yet - you'll get false negatives.          ║
║                                                                      ║
║  ✅ ALWAYS use gh pr diff or git diff against feature branch         ║
╚══════════════════════════════════════════════════════════════════════╝

**Find and verify PR:**
# Find PR for this ticket
gh pr list --search "${TICKET_ID}" --json number,headRefName

# Use PR diff as source of truth
gh pr diff <PR_NUMBER>

**If no PR found (on feature branch):**
git diff origin/main...HEAD

---

## Step 1: Identify requirements

- Fetch ticket details using the configured provider's MCP tool for ticket "${TICKET_ID}"
- Extract acceptance criteria
- Note any sub-tasks or linked issues

---

## Step 2: Verify each requirement IN THE PR DIFF

**For each acceptance criterion:**
# Check if pattern exists in PR changes
gh pr diff <PR_NUMBER> | grep -A5 "pattern"

# List changed files
gh pr view <PR_NUMBER> --json files -q '.files[].path'

# Check specific file was modified
gh pr diff <PR_NUMBER> -- path/to/expected/file.ts

**Verification checklist:**
- [ ] File created/modified as expected?
- [ ] Function/component implemented?
- [ ] Tests added/updated?
- [ ] Types correct?

---

## Step 3: Report status

For each requirement:
| Requirement | Status | Evidence |
|-------------|--------|----------|
| [from ticket] | DELIVERED / PENDING | [file/line from PR diff] |

**Final verdict:** COMPLETE or INCOMPLETE

📁 Save to: ${REPORT_FOLDER}/completion.check.md
⚠️ Start with: **Changes Hash:** ${CHANGES_HASH}

Include:
- PR number checked
- Each requirement with DELIVERED/PENDING
- Evidence from PR diff (not local files)
- Final status
```

---

## Step 5_phase2_consensus: Phase 2 Consensus Loop

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 5_phase2_consensus
```

⚠️ **CRITICAL: Wait for ALL Phase 1 agents to complete before this step.**

Use `TaskOutput` to wait for all Phase 1 agents, then launch Phase 2 sequentially.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  PHASE 1 (parallel)                    PHASE 2 (consensus loop)           │
│  ┌─────────────────┐                   ┌─────────────────────────────┐    │
│  │  code-checker   │──────────────────►│ DYNAMIC Developer(s)        │    │
│  │  (suggestions)  │                   │ (evaluate suggestions)      │    │
│  └─────────────────┘                   │ • nodejs-tdd (backend)      │    │
│  ┌─────────────────┐                   │ • react-senior (UI)         │    │
│  │ quality-checker │                   │ • devops (infra)            │    │
│  └─────────────────┘                   └───────────┬─────────────────┘    │
│  ┌─────────────────┐                               │                      │
│  │qa-feature-tester│                               ▼                      │
│  └─────────────────┘                   ┌─────────────────────────────┐    │
│  ┌─────────────────┐                   │ code-checker (validation)   │    │
│  │  qa-api-tester  │                   │ AGREE or DISAGREE?          │◄───┤
│  └─────────────────┘                   └───────────┬─────────────────┘    │
│  ┌─────────────────┐                               │                      │
│  │completion-checker│                  ┌───────────┴───────────┐          │
│  └─────────────────┘                   │                       │          │
│                                   AGREE│                       │DISAGREE  │
│                                        ▼                       │          │
│                            ┌─────────────────────┐    ┌────────┴──────┐   │
│                            │ code-review-reply   │    │ Next Iteration│───┘
│                            │ (consensus reached) │    │ (loop back)   │
│                            └─────────┬───────────┘    └───────────────┘
│                                      │                                    │
│                                      ▼                                    │
│                            ┌─────────────────────┐                        │
│                            │ quality-checker     │                        │
│                            │ (re-run if needed)  │                        │
│                            └─────────────────────┘                        │
└───────────────────────────────────────────────────────────────────────────┘
```

### Phase 2 Step 1: Determine Developer Agents (DYNAMIC SELECTION)

```bash
DEVELOPER_RESULT=$(node ${CLAUDE_PLUGIN_ROOT}/hooks/check-determine-developers.js '${JSON.stringify(AFFECTED_FILES)}')
echo "$DEVELOPER_RESULT"
```

**Parse the result:**
```javascript
const DEVELOPER_RESULT = JSON.parse(DEVELOPER_RESULT_OUTPUT);
const INVOLVED_DEVELOPERS = DEVELOPER_RESULT.developers;
const NEEDS_CONSENSUS = DEVELOPER_RESULT.needsConsensus;
```

**Developer Selection Table:**

| Change Type | Patterns | Developer Agent |
|-------------|----------|-----------------|
| Backend/API | routes/, services/, api/, workers/, .sql, migrations/ | `developer-nodejs-tdd` |
| Frontend/UI | .tsx, components/, pages/, hooks/, packages/ui/ | `developer-react-senior` |
| DevOps/Infra | .github/workflows/, Dockerfile, terraform/, k8s/ | `developer-devops` |

### Phase 2 Step 2: Code Review Reply with Consensus

**ALWAYS use consensus loop** — code-checker must validate developers' decisions.

**Consensus Algorithm:**

```
MAX_ITERATIONS = 3
iteration = 0
consensus = false

WHILE !consensus AND iteration < MAX_ITERATIONS:
    iteration++

    IF iteration == 1:
        # PARALLEL: First iteration - developers work independently
        FOR EACH developer IN INVOLVED_DEVELOPERS (all in ONE message):
            Task(developer): [code review reply prompt]
    ELSE:
        # SEQUENTIAL: Later iterations - developers review others' decisions
        FOR EACH developer IN INVOLVED_DEVELOPERS (one at a time):
            Task(developer): [re-review with merged decisions]

    # After all developers respond:
    FOR EACH developer IN INVOLVED_DEVELOPERS:
        1. Read developer's reply from ${REPORT_FOLDER}/${developer}-reply-v${iteration}.md
        2. Parse decisions: IMPLEMENTED | DEFERRED | NOT_APPLICABLE
        3. Parse checkbox: /\[x\]\s*I AGREE/i or /\[x\]\s*I DISAGREE/i
        4. Log to ${REPORT_FOLDER}/code-review-consensus-log.md

    # ⚠️ CRITICAL: Code-checker must validate developers' decisions
    Task(code-checker): [consensus validation prompt - see below]
    1. Read ${REPORT_FOLDER}/code-checker-consensus-v${iteration}.md
    2. Parse agreement: AGREE | DISAGREE per suggestion
    3. Log to ${REPORT_FOLDER}/code-review-consensus-log.md

    IF any developer OR code-checker disagreed on any suggestion:
        - Log disagreements to consensus-log (include who disagreed)
        - If code-checker disagrees: developers must reconsider in next iteration
        - If developers disagree among themselves: merge using priority
        - Merge decisions using priority: IMPLEMENTED > NOT_APPLICABLE > DEFERRED
        - Mark consensus = false
        - Continue loop
    ELSE:
        - All developers AND code-checker checked [x] I AGREE
        - Mark consensus = true
        - EXIT loop

IF iteration >= MAX_ITERATIONS AND !consensus:
    # Escalate to user - parties couldn't agree
    AskUserQuestion: "Developers and code-checker couldn't reach consensus. How to proceed?"
    Options:
      - Accept majority decision (use most common decision per suggestion)
      - Accept most conservative (defer anything disputed)
      - Choose per-suggestion (I'll decide each disputed item)
      - Skip code review reply (proceed without implementing suggestions)

    IF "Choose per-suggestion" selected:
        FOR EACH disputed suggestion:
            AskUserQuestion: "For '${suggestion}': What decision?"
            Options: [Show each party's recommendation + reasoning]
```

**Agent Timeouts (Phase 2):**
| Agent | Max Time | On Timeout |
|-------|----------|------------|
| developer-* (each) | 5 min | Mark TIMEOUT, continue |
| consensus loop | 15 min total | Escalate to user |

### Code-Checker Consensus Validation Prompt

**After developers submit their replies, launch code-checker to validate:**

```
Validate developers' decisions on your code review suggestions.

REPORT_FOLDER: ${REPORT_FOLDER}
CHANGES_HASH: ${CHANGES_HASH}
TICKET_ID: ${TICKET_ID}
ITERATION: ${iteration}
INVOLVED_DEVELOPERS: ${INVOLVED_DEVELOPERS.join(', ')}

${REVIEW_DOCS ? `
## Project-Specific Review Rules

IMPORTANT: Apply these project-specific rules as PRIMARY review criteria.
Validate developers' decisions against these rules in addition to ticket requirements.

${REVIEW_DOCS}
` : ''}

## Your Role

You made suggestions in code-review.check.md. Developers have now responded with their decisions.
Your job is to AGREE or DISAGREE with each decision, **especially validating against ticket requirements**.

## Your Task

1. Read your original suggestions from ${REPORT_FOLDER}/code-review.check.md
2. **⚠️ CRITICAL: Read ticket requirements:**
   - Fetch ticket details using the configured provider's MCP tool for ticket "${TICKET_ID}"
   - Extract Acceptance Criteria and Testing Requirements
   - Use these to validate DEFERRED decisions
3. Read each developer's reply:
   ${INVOLVED_DEVELOPERS.map(d => `- ${REPORT_FOLDER}/${d}-reply-v${iteration}.md`).join('\n   ')}
4. For EACH suggestion, evaluate the developer's decision:
   - IMPLEMENTED → Did they actually implement it correctly?
   - DEFERRED → **Does this suggestion match ticket acceptance criteria?**
     - If YES → You MUST DISAGREE (cannot defer required work)
     - If NO → Is the deferral reason valid?
   - NOT_APPLICABLE → Do you agree it's not applicable?

## Output Format

Create ${REPORT_FOLDER}/code-checker-consensus-v${iteration}.md:

\`\`\`markdown
# Code-Checker Consensus Validation

**Changes Hash:** ${CHANGES_HASH}
**Date:** [today]
**Iteration:** ${iteration}

---

## Suggestion: [exact title from code-review.check.md]
**Developer Decision:** [IMPLEMENTED | DEFERRED | NOT_APPLICABLE]
**Decided By:** [developer name]
**My Verdict:** AGREE | DISAGREE
**Reason:** [If DISAGREE, explain why and what should happen instead]

---
[Repeat for each suggestion]

---

## Final Agreement

- [ ] I AGREE with all developers' decisions
- [ ] I DISAGREE on some suggestions (listed above with reasons)
\`\`\`

## Rules

- ✅ Be fair - if deferral reason is valid AND does not contradict ticket requirements, accept it
- ✅ Check IMPLEMENTED suggestions were actually implemented correctly
- ✅ Provide specific technical reasons for any disagreement
- ✅ **Cross-reference EVERY DEFERRED decision against ticket acceptance criteria**
- ❌ Don't be pedantic - minor deviations from your suggestion are OK
- ❌ Don't insist on suggestions you marked as 🟢 Nice-to-Have if developers have good reasons to defer
- ❌ **NEVER accept DEFERRED for suggestions that match ticket requirements - you MUST DISAGREE**

📁 Save to: ${REPORT_FOLDER}/code-checker-consensus-v${iteration}.md
```

### Developer Code Review Evaluator Prompt (DYNAMIC)

**Launch the appropriate developer(s) based on INVOLVED_DEVELOPERS.**

```
Evaluate code review suggestions and create your reply.

REPORT_FOLDER: ${REPORT_FOLDER}
CHANGES_HASH: ${CHANGES_HASH}
TICKET_ID: ${TICKET_ID}
DEVELOPER_TYPE: ${DEVELOPER_TYPE}  // e.g., "developer-nodejs-tdd"

${DEV_DOCS ? `
## Project-Specific Development Rules

IMPORTANT: Apply these project-specific rules when evaluating suggestions and implementing fixes.
Suggestions that align with these rules should be prioritized for implementation.

${DEV_DOCS}
` : ''}
ITERATION: ${iteration}  // 1, 2, or 3
OTHER_DEVELOPERS: ${INVOLVED_DEVELOPERS.filter(d => d !== DEVELOPER_TYPE)}

⚠️ **CRITICAL: SHA VALIDATION**
The reply MUST include the same Changes Hash as code-review.check.md.
This is validated by a hook - mismatched hashes will block completion.

## Your Domain Focus

Based on your expertise, focus on suggestions relevant to:
- **developer-nodejs-tdd**: Backend code, API routes, services, database, workers
- **developer-react-senior**: React components, hooks, state management, UI logic
- **developer-devops**: CI/CD, infrastructure, deployment, Docker, workflows

For suggestions OUTSIDE your domain, you may:
- Defer to the other developer's judgment
- Still comment if you have cross-cutting concerns

## Your Task

1. Read ${REPORT_FOLDER}/code-review.check.md
2. EXTRACT the **Changes Hash:** - you MUST use this exact hash
3. **⚠️ CRITICAL: Read ticket requirements:**
   - Fetch ticket details using the configured provider's MCP tool for ticket "${TICKET_ID}"
   - Extract Acceptance Criteria and Testing Requirements
   - You CANNOT defer suggestions that match explicit ticket requirements
4. ${iteration > 1 ? `Read other developers' replies: ${OTHER_DEVELOPERS.map(d => `${d}-reply-v${iteration-1}.md`)}` : ''}
5. For EACH suggestion (🟢 SUGGESTION or 🔵 Nice-to-Have), evaluate:
   - Is this in YOUR domain of expertise?
   - **Does this match any ticket acceptance criteria or testing requirements?**
   - Can this be implemented quickly (< 5 minutes)?
   - Is it within scope of this PR?
   - Does it add real value?

6. For quick fixes in YOUR domain:
   - **ACTUALLY IMPLEMENT THEM** in the codebase
   - Mark as IMPLEMENTED in the reply

7. **⚠️ CRITICAL: For suggestions that MATCH ticket requirements:**
   - You **CANNOT** mark as DEFERRED
   - You MUST either IMPLEMENT or explain why NOT_APPLICABLE
   - "Out of scope" is NOT valid if the ticket explicitly requires it

8. For complex suggestions that do NOT match ticket requirements:
   - Mark as DEFERRED with specific reason
   - Explain WHY it's deferred

9. For suggestions you disagree with:
   - Mark as NOT APPLICABLE
   - Provide technical justification

10. ${iteration > 1 ? 'Review other developers\' decisions and note any disagreements' : ''}

## Output Format

Create ${REPORT_FOLDER}/${DEVELOPER_TYPE}-reply-v${iteration}.md:

\`\`\`markdown
# Code Review Reply - ${DEVELOPER_TYPE}

**Changes Hash:** ${CHANGES_HASH}
**Date:** [today]
**Developer:** ${DEVELOPER_TYPE}
**Iteration:** ${iteration}

---

## Suggestion: [exact title from code-review.check.md]
**My Domain:** YES | NO | PARTIAL
**Decision:** IMPLEMENTED | DEFERRED | NOT_APPLICABLE | DEFER_TO_OTHER
**Reason:** [Specific technical justification]
**Action:** [If IMPLEMENTED, what file/line was changed]
${iteration > 1 ? '**Other Developer Said:** [their decision]\n**I Agree:** YES | NO - [reason if NO]' : ''}

---
[Repeat for each suggestion]

---

## Agreement Status

${iteration === 1 ? `
Review all suggestions and mark your agreement:
- [ ] I AGREE with all my decisions above
- [ ] I SUGGEST CHANGES (see disagreements below)
` : `
After reviewing other developers' decisions:
- [ ] I AGREE with the merged decisions
- [ ] I DISAGREE on some suggestions (listed below)

### Disagreements (if any)
| Suggestion | My Decision | Other's Decision | My Reasoning |
|------------|-------------|------------------|--------------|
| ... | ... | ... | ... |
`}
\`\`\`

## Rules

- ❌ DO NOT just mark everything as DEFERRED
- ❌ **NEVER defer suggestions that match ticket acceptance criteria or testing requirements**
- ✅ Actually try to implement quick fixes IN YOUR DOMAIN
- ✅ Provide specific technical reasons
- ✅ If you implement something, run lint to verify it compiles
- ✅ Be respectful of other developers' domain expertise
- ✅ Flag cross-cutting concerns even outside your domain
- ✅ **Cross-reference every DEFERRED decision against ticket requirements**

📁 Save to: ${REPORT_FOLDER}/${DEVELOPER_TYPE}-reply-v${iteration}.md
```

**After all developers complete (single or multi):**

Merge all `*-reply-v${iteration}.md` files into final `code-review-reply.check.md`:

```markdown
# Code Review Reply

**Changes Hash:** ${CHANGES_HASH}
**Date:** [today]
**Developers:** ${INVOLVED_DEVELOPERS.join(', ')}
**Consensus:** REACHED | ESCALATED_TO_USER

---

## Suggestion: [title]
**Final Decision:** IMPLEMENTED | DEFERRED | NOT_APPLICABLE
**Decided By:** [developer who owns this domain]
**Reason:** [from their reply]
**Action:** [if implemented]

---
[Repeat for each suggestion]
```

**After consensus:** Determine next step:
- If any IMPLEMENTED suggestions exist → transition to `6_quality_recheck`
- If no implementations → transition to `7_validate_summary`

---

## Step 6_quality_recheck: Quality Re-check (Affected Files Only)

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 6_quality_recheck
```

⚠️ **Only runs if developer agent modified files (IMPLEMENTED suggestions).**

Parse implemented files from code-review-reply.check.md, then launch quality-checker:

```
Re-validate files modified by code-review-reply fixes.

REPORT_FOLDER: ${REPORT_FOLDER}
CHANGES_HASH: ${CHANGES_HASH}
AFFECTED_FILES_ONLY: ${JSON.stringify(implementedFiles)}

⚠️ This is a TARGETED re-run - only check files that were modified.

Commands to run (only on affected files):
1. pnpm lint --filter=<affected-packages>
2. pnpm typecheck --filter=<affected-packages>
3. pnpm test --filter=<affected-packages>

**Conditional integration test re-run:**
If implementedFiles include backend patterns (routes/, services/, api/, workers/, .sql, migrations/),
ALSO run integration tests since backend logic may have changed:
4. pnpm dev:integration <app> (only if backend files modified; fallback: pnpm test:integration --filter=<affected-packages>)

📁 Append results to: ${REPORT_FOLDER}/tests.check.md

Add section:
## Re-validation (Post Code Review Fixes)
- Files checked: [list]
- Lint: PASS/FAIL
- TypeCheck: PASS/FAIL
- Unit Tests: PASS/FAIL

Status: APPROVED (all pass) or NEEDS_WORK (any failures)
```

After quality re-check completes, transition to `7_validate_summary`.

---

## Step 7_validate_summary: Validate and Generate Summary

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 7_validate_summary
```

After all agents complete, validate reports and generate summary.

**First, check for infrastructure failures:**

```bash
# Check if any QA report indicates Playwright failure
if grep -l "PLAYWRIGHT_UNAVAILABLE\|INFRASTRUCTURE_FAILURE" ${REPORT_FOLDER}/qa-*.check.md 2>/dev/null; then
  echo "🛑 Infrastructure failure detected"
fi
```

**If infrastructure failure detected:**
```
╔══════════════════════════════════════════════════════════════════════╗
║  🛑 CHECK ABORTED - INFRASTRUCTURE FAILURE                           ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  QA testing FAILED due to Playwright unavailability.                 ║
║                                                                      ║
║  ACTION REQUIRED:                                                    ║
║  1. Check Playwright MCP connection                                  ║
║  2. Re-run /check after fixing                                       ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
```
Exit with INFRASTRUCTURE_FAILURE status (not APPROVED).

**If no infrastructure failures:** Continue with validation:

```bash
# Validate reports
node ${CLAUDE_PLUGIN_ROOT}/hooks/check-validate-reports.js "${REPORT_FOLDER}" '${JSON.stringify(IMPACTED_APPS)}'

# Generate summary README.md
node ${CLAUDE_PLUGIN_ROOT}/hooks/check-generate-summary.js "${REPORT_FOLDER}" "${CHANGES_HASH}" "${TICKET_ID}" '${JSON.stringify(IMPACTED_APPS)}'
```

**Validation rules (causes NEEDS_WORK):**
- 🔴 CRITICAL in code-review.check.md → NEEDS_WORK
- 🟡 IMPORTANT in code-review.check.md → NEEDS_WORK
- Missing `**Changes Hash:**` at top of any report → INVALID
- Missing qa-*.check.md for any impacted app → INCOMPLETE
- Any test failures in tests.check.md → NEEDS_WORK
- Missing code-review-reply.check.md → INCOMPLETE
- code-review-reply.check.md Changes Hash doesn't match code-review.check.md → INVALID (reply is outdated)
- All suggestions marked DEFERRED without attempting quick fixes → NEEDS_WORK

**All must pass for APPROVED status.**

---

## Step 8_output: Final Output

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 8_output
```

Display summary to user:

```
Quality Check Complete!

| Phase | Check | Status |
|-------|-------|--------|
| 1 | Quality Checker | ✅/❌ |
| 1 | Code Checker | ✅/❌ |
| 1 | QA Tester (UI) | ✅/❌ |
| 1 | QA Tester (API) | ✅/❌/⏭️ (skipped) |
| 1 | Completion | ✅/❌ |
| 2 | Code Review Reply | ✅/❌/⏭️ (no suggestions) |
| 2 | Quality Re-check | ✅/❌/⏭️ (no fixes) |

Changes Hash: ${CHANGES_HASH}
Reports saved to: ${REPORT_FOLDER}/

${IF NEEDS_WORK}
❌ Action required - see reports for details.
${ELSE}
✅ All checks passed! Ready for PR.
${ENDIF}
```

---

## Step 9_cleanup: Cleanup (ALWAYS RUN)

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js check transition ${INSTANCE_ID} 9_cleanup
```

Stop all services started in Step 2_start_env:

```bash
# ⚠️ CRITICAL: Only cleanup YOUR ticket's resources - NEVER use pkill!
# Other Claude agents may be running concurrently.

# Kill dev servers by PID if available (from RUNNING_APPS started by THIS agent)
if [ -n "$ENV_RESULT" ]; then
  echo "$ENV_RESULT" | jq -r '.apps[].pid // empty' 2>/dev/null | while read PID; do
    [ -n "$PID" ] && kill $PID 2>/dev/null || true
  done
fi

# Kill only YOUR ticket's tmux session (NEVER pkill - it kills other agents!)
TICKET_ID="${TICKET_ID:-${JIRA_TICKET_ID:-}}"
if [ -n "$TICKET_ID" ]; then
  tmux kill-session -t "${TICKET_ID}-dev" 2>/dev/null || true
fi

# Stop database container (shared, so be careful - only if YOU started it)
# docker stop postgres-local 2>/dev/null || true
```

**Run cleanup regardless of success/failure** to prevent orphaned processes.

⚠️ **FORBIDDEN cleanup commands** (will break other agents):
- `pkill -f "pnpm dev"` - kills ALL dev servers across all agents
- `pkill -f "vite"` - kills ALL vite processes
- `tmux kill-session -t <other-ticket>-*` - kills other agents' sessions

---

## Quick Reference

| Script | Purpose |
|--------|---------|
| `${CLAUDE_PLUGIN_ROOT}/hooks/check-setup.js` | Setup variables, generate hash, check cache |
| `${CLAUDE_PLUGIN_ROOT}/hooks/check-start-env.js` | Start database and apps |
| `${CLAUDE_PLUGIN_ROOT}/hooks/check-determine-developers.js` | Determine which developer agents to involve |
| `${CLAUDE_PLUGIN_ROOT}/hooks/check-validate-reports.js` | Validate all reports exist and are complete |
| `${CLAUDE_PLUGIN_ROOT}/hooks/check-generate-summary.js` | Generate README.md summary |
| Step 9_cleanup commands | Stop background services (inline, no script) |

| Variable | Description |
|----------|-------------|
| `INSTANCE_ID` | Workflow instance ID (ticket ID or branch name) |
| `REPORT_FOLDER` | Where reports are saved |
| `CHANGES_HASH` | 12-char hash for cache validation |
| `IMPACTED_APPS` | Array of changed apps |
| `RUNNING_APPS` | Object with app URLs and ports |
| `DB_ENV` | Database environment variables |
| `INVOLVED_DEVELOPERS` | Array of developer agents to involve in code review |
| `NEEDS_CONSENSUS` | Boolean - true if multiple developers need consensus |
| `REVIEW_DOCS` | Project-specific review docs (from `READ_DOCS_ON_REVIEW`) |
| `QA_DOCS` | Project-specific QA docs (from `READ_DOCS_ON_QA`) |
| `DEV_DOCS` | Project-specific dev docs (from `READ_DOCS_ON_DEV`) |
| `E2E_DOCS` | Project-specific E2E testing docs (from `READ_DOCS_ON_E2E`) |
| `TEST_DOCS` | Project-specific unit testing docs (from `READ_DOCS_ON_TEST`) |

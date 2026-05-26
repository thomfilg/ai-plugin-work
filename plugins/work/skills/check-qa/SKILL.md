---
name: check-qa
argument-hint: <app-name> [options-json]
description: Run QA testing for a specific app using Playwright MCP
user-invocable: true
allowed-tools: Task, Bash, Read, AskUserQuestion
---

# /check-qa - QA Testing for Single App

Run QA testing for a specific application by launching the `qa-feature-tester` agent.

## What This Command Does

1. Parse arguments (app name + optional JSON options)
2. If no arguments → auto-discover affected apps
3. **Initialize QA progress tracking** (enables resume on context loss)
4. **Cleanup old screenshots** for the specific app being tested
5. Launch `qa-feature-tester` agent with context
6. Agent handles ALL testing (Playwright, screenshots, report)

## Context Loss Protection

This command uses `${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js` to track progress incrementally.
If interrupted, QA can resume from where it left off.

**Progress file:** `$HOME/worktrees/tasks/{TICKET_ID}/.qa-progress-{APP_NAME}.json`

---

## Step 1: Parse Arguments

```javascript
const rawArgs = "$ARGUMENTS".trim();

// If no arguments, go to Step 2 (auto-discover)
if (!rawArgs) {
  // Continue to auto-discovery
}

// Parse: "app-name" or "app-name {json}"
const args = rawArgs.split(/\s+(.+)/);
const APP_NAME = args[0];
const options = args[1] ? JSON.parse(args[1]) : {};

// Defaults
const TICKET_ID = options.ticketId || options.jiraTicketId || ''; // Extract from branch if empty (jiraTicketId accepted for backward compat)
const GLOBAL_TASKS = `${process.env.HOME}/worktrees/tasks`;
const TASK_FOLDER = `${GLOBAL_TASKS}/${TICKET_ID || 'unknown'}`;
const REPORT_PATH = options.reportPath || `${TASK_FOLDER}/qa-${APP_NAME}.md`;
const CHANGES_HASH = options.changesHash || 'NO_HASH';
const SCREENSHOTS_FOLDER = options.screenshotsFolder || `${TASK_FOLDER}/screenshots/${APP_NAME}`;
const AFFECTED_FILES = options.affectedFiles || [];
const AFFECTED_PACKAGES = options.affectedPackages || [];
const QA_DOCS = options.qaDocs || '';   // from READ_DOCS_ON_QA via check-setup.js
const E2E_DOCS = options.e2eDocs || ''; // from READ_DOCS_ON_E2E via check-setup.js

// App URL from structured access payload (provided by check-start-env.js via RUNNING_APPS)
// RUNNING_APPS is set by the /check workflow; parse it to get the URL for each app.
const runningApps = JSON.parse(process.env.RUNNING_APPS || '{}');
const APP_URL = options.appUrl || (runningApps[APP_NAME] && runningApps[APP_NAME].url) || 'http://host.docker.internal:3000';
```

---

## Step 2: Auto-Discover Affected Apps (if no arguments)

**Only run this if `$ARGUMENTS` is empty.**

```bash
# Discover affected apps
AFFECTED_APPS=$(node scripts/get-affected.js main json)
echo "Affected apps: $AFFECTED_APPS"
```

Parse and filter to QA-testable apps using the app manifest (via `discoverApps`):
```javascript
const path = require('path');
const { discoverApps } = require(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'workflows', 'check', 'lib', 'app-access'));

const allAffected = JSON.parse(AFFECTED_APPS);
const manifest = discoverApps();

// Filter affected apps to those in the manifest, then route by appType
const qaApps = allAffected.filter(app => {
  const entry = manifest.find(m => m.name === app);
  if (!entry) return false;
  // cli apps are tested by automated tests only — skip QA
  if (entry.appType === 'cli') return false;
  return true;
});
```

### appType Routing

The app manifest declares an `appType` for each app. Use it to select the correct QA agent:

| appType | QA Agent | Testing Method |
|---------|----------|----------------|
| `web` | `qa-feature-tester` | Browser-based testing via Playwright MCP / Chrome MCP |
| `api` | `qa-api-tester` | API testing via curl/HTTP requests |
| `cli` | _(skip QA)_ | Tested only by quality-checker automated tests |

```javascript
for (const appName of qaApps) {
  const entry = manifest.find(m => m.name === appName);
  const appType = entry?.appType || 'web';

  if (appType === 'web') {
    // Launch qa-feature-tester (browser-based QA)
    // See Step 3 below
  } else if (appType === 'api') {
    // Launch qa-api-tester (HTTP/curl-based QA)
  }
  // cli apps were already filtered out above
}
```

| Result | Action |
|--------|--------|
| 0 QA apps | Ask user to select from manifest entries |
| 1 QA app | Launch agent for that app |
| 2+ QA apps | **Go to Step 2.1 to verify actual usage** |

**If no QA apps found:**
```javascript
// Build options dynamically from the manifest
const manifestApps = discoverApps().filter(m => m.appType !== 'cli');
// Present each app with its name and default port
```
```
AskUserQuestion:
  question: "No QA-testable apps affected. Which app to test?"
  header: "App"
  options: [dynamically built from discoverApps() manifest entries]
```

---

## Step 2.1: Verify Component Usage in Apps (CRITICAL)

**When shared packages (shared-ui, ui) are changed, verify each app ACTUALLY uses the changed components.**

This prevents running QA on apps that are only "transitively affected" but don't actually use the changed code.

### 2.1.1: Identify Changed Components from Shared Packages

```bash
# Get files changed in shared packages
# Detect base branch dynamically (origin/main, origin/dev, origin/master)
# Priority: $BASE_BRANCH env var → git symbolic-ref → probe common names → fallback
BASE_BRANCH="${BASE_BRANCH:-$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||')}"
if [ -z "$BASE_BRANCH" ]; then
  for b in origin/main origin/dev origin/master; do
    if git rev-parse --verify "$b" >/dev/null 2>&1; then BASE_BRANCH="$b"; break; fi
  done
fi
BASE_BRANCH="${BASE_BRANCH:-origin/main}"
CHANGED_FILES=$(git diff --name-only ${BASE_BRANCH}...HEAD)

# Extract component names from shared-ui/ui changes
# Pattern: packages/shared-ui/src/components/ComponentName/
# Pattern: packages/ui/src/components/ComponentName/
```

**Extract component names:**
```javascript
const changedFiles = CHANGED_FILES.split('\n');
const componentPattern = /packages\/(shared-ui|ui)\/src\/components\/([^\/]+)\//;
const changedComponents = [...new Set(
  changedFiles
    .map(f => f.match(componentPattern)?.[2])
    .filter(Boolean)
)];

// Example: ["TimeRangeSelector", "DataGrid"]
console.log("Changed shared components:", changedComponents);
```

### 2.1.2: Check Each App for Component Usage

**For each QA-testable app, verify it actually imports/uses the changed components:**

```bash
# For each changed component, check if app uses it
for APP in $QA_APPS; do
  for COMPONENT in $CHANGED_COMPONENTS; do
    # Search for imports in the app
    USAGE=$(grep -r "$COMPONENT" apps/$APP/app --include="*.tsx" --include="*.ts" 2>/dev/null | head -5)
    if [ -n "$USAGE" ]; then
      echo "✅ $APP uses $COMPONENT"
      # Add to VERIFIED_APPS
    else
      echo "⏭️ $APP does NOT use $COMPONENT - skipping"
    fi
  done
done
```

**Grep patterns to check:**
```bash
# Import from package
grep -r "from '@$REPO_NAME/shared-ui'" apps/$APP/app --include="*.tsx" | grep "$COMPONENT"
grep -r "from '@$REPO_NAME/ui'" apps/$APP/app --include="*.tsx" | grep "$COMPONENT"

# Direct component usage in JSX
grep -r "<$COMPONENT" apps/$APP/app --include="*.tsx"
```

### 2.1.3: Decision Matrix

| Scenario | Action |
|----------|--------|
| App directly changed (files in `apps/$APP/`) | Always include in QA |
| App uses changed shared component | Include in QA |
| App marked affected but doesn't use changed component | **SKIP QA** (log reason) |
| Only shared package tests changed | Skip QA for all apps |

### 2.1.4: Example Analysis Output

```
📊 Component Usage Analysis:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Changed components: [TimeRangeSelector]

status-site:
  ✅ Direct changes in apps/status-site/
  ✅ Uses TimeRangeSelector (apps/status-site/app/routes/queue-dashboard.tsx:15)
  → INCLUDE in QA

as-dashboard:
  ⚠️ No direct changes
  ❌ Does NOT import TimeRangeSelector
  → SKIP QA (transitive dependency only)

status-site-admin:
  ⚠️ No direct changes
  ❌ Does NOT import TimeRangeSelector
  → SKIP QA

as-dashboard-admin:
  ⚠️ No direct changes
  ❌ Does NOT import TimeRangeSelector
  → SKIP QA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Final QA targets: [status-site]
```

### 2.1.5: Implementation Steps

1. **Run this Bash command to extract changed components:**
```bash
# Detect base branch dynamically
# Priority: $BASE_BRANCH env var → git symbolic-ref → probe common names → fallback
BASE_BRANCH="${BASE_BRANCH:-$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||')}"
if [ -z "$BASE_BRANCH" ]; then
  for b in origin/main origin/dev origin/master; do
    if git rev-parse --verify "$b" >/dev/null 2>&1; then BASE_BRANCH="$b"; break; fi
  done
fi
BASE_BRANCH="${BASE_BRANCH:-origin/main}"
git diff --name-only ${BASE_BRANCH}...HEAD | grep -E "packages/(shared-ui|ui)/src/components/[^/]+/" | sed 's|.*/components/||' | cut -d'/' -f1 | sort -u
```

2. **For each QA-testable app, check usage:**
```bash
# Example: Check if status-site uses TimeRangeSelector
grep -rn "TimeRangeSelector" apps/status-site/app --include="*.tsx" --include="*.ts"
```

3. **Build final verified apps list:**
```javascript
const verifiedApps = qaApps.filter(app => {
  // Always include if app has direct changes
  const hasDirectChanges = changedFiles.some(f => f.startsWith(`apps/${app}/`));
  if (hasDirectChanges) return true;

  // Check if app uses any changed shared component
  return changedComponents.some(component => appUsesComponent(app, component));
});
```

**IMPORTANT:** Only launch QA agents for `verifiedApps`, not all `qaApps`.

---

## Step 2.5: Cleanup App-Specific Screenshots (BEFORE QA)

**Clean up existing screenshots for THIS APP ONLY before running QA.**

This ensures fresh screenshots are generated and old ones don't pollute the results.

```bash
# Clean up screenshots for the specific app being tested
if [ -d "${SCREENSHOTS_FOLDER}" ]; then
  echo "🧹 Cleaning up old screenshots for ${APP_NAME}..."
  rm -rf "${SCREENSHOTS_FOLDER}"/*
  echo "✅ Removed old screenshots from: ${SCREENSHOTS_FOLDER}"
else
  echo "📁 Creating screenshots folder for ${APP_NAME}..."
  mkdir -p "${SCREENSHOTS_FOLDER}"
fi
```

**Example cleanup paths:**
- `status-site` → `tasks/PROJ-XXX/screenshots/status-site/`
- `as-dashboard` → `tasks/PROJ-XXX/screenshots/as-dashboard/`

**Note:** Only cleans the specific app folder, NOT the entire screenshots directory.

---

## Step 2.6: Initialize QA Progress Tracking (CONTEXT LOSS PROTECTION)

**CRITICAL: Initialize progress tracking BEFORE launching QA agent.**

This creates a checkpoint file that enables resume on context loss.

```bash
# Initialize QA progress tracking
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js init "${TICKET_ID}" "${APP_NAME}" "${APP_URL}"

echo "✅ QA progress tracking initialized"
echo "   Progress file: $HOME/worktrees/tasks/${TICKET_ID}/.qa-progress-${APP_NAME}.json"
```

**Check for existing progress (resume detection):**
```bash
# Check if we can resume from previous run
RESUME_INFO=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js resume-info "${TICKET_ID}" "${APP_NAME}")
CAN_RESUME=$(echo "$RESUME_INFO" | jq -r '.canResume')
COMPLETED_TESTS=$(echo "$RESUME_INFO" | jq -r '.completedTests | length')

if [ "$CAN_RESUME" = "true" ] && [ "$COMPLETED_TESTS" -gt 0 ]; then
  echo "🔄 RESUME DETECTED: Found ${COMPLETED_TESTS} completed tests from previous run"
  echo "   Skipping completed tests, continuing from where we left off..."
fi
```

**Pass resume info to agent:**
```javascript
const resumeInfo = JSON.parse(RESUME_INFO);
// Agent will skip tests in resumeInfo.completedTests
```

---

## Step 3: Launch QA Agent (REQUIRED)

**YOU MUST launch the qa-feature-tester agent using Task tool.**

```
Task(subagent_type: "work-workflow:qa-feature-tester", prompt: "
Test ${APP_NAME} application.

## SERVER IS ALREADY RUNNING — DO NOT START ANY DEV SERVERS

╔══════════════════════════════════════════════════════════════════════╗
║  THE APP SERVER IS ALREADY RUNNING AND READY FOR TESTING             ║
║                                                                      ║
║  URL: ${APP_URL}                                                     ║
║                                                                      ║
║  FORBIDDEN COMMANDS (will break other agents):                       ║
║  - pnpm dev, pnpm start, make dev-local                             ║
║  - tmux new-session ... pnpm dev                                     ║
║  - npm run dev, npx vite, npx remix dev                              ║
║  - sleep && curl (health checks to wait for server startup)          ║
║  - Starting ANY server process whatsoever                            ║
║                                                                      ║
║  JUST NAVIGATE TO THE URL ABOVE WITH PLAYWRIGHT AND START TESTING.  ║
╚══════════════════════════════════════════════════════════════════════╝

Your FIRST action must be:
  mcp__playwright__browser_navigate(url: '${APP_URL}')

If the page does not load, report ACCESS_FAILED (infrastructure issue, not a test failure).
Do NOT attempt to start a server yourself.

## Context Variables
- TICKET_ID: ${TICKET_ID}
- REPORT_PATH: ${REPORT_PATH}
- CHANGES_HASH: ${CHANGES_HASH}
- APP_URL: ${APP_URL}
- SCREENSHOTS_FOLDER: ${SCREENSHOTS_FOLDER}

## Progress Tracking (CRITICAL - enables resume on context loss)
- PROGRESS_SCRIPT: ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js
- Use these commands to track progress:
  - Start test: node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js start-test ${TICKET_ID} ${APP_NAME} 'test_name'
  - Complete test: node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js complete-test ${TICKET_ID} ${APP_NAME} 'test_name' pass 'screenshot.png'
  - Fail test: node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js fail-test ${TICKET_ID} ${APP_NAME} 'test_name' 'error message'
  - Playwright status: node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js set-playwright ${TICKET_ID} ${APP_NAME} true/false
  - Infrastructure failure: node ${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/hooks/qa-progress.js infrastructure-failure ${TICKET_ID} ${APP_NAME} 'error'

## Resume Info (skip already-completed tests)
${JSON.stringify(resumeInfo || { completedTests: [] })}

## Files Changed
${AFFECTED_FILES.join('\n') || 'None specified'}

## Packages Changed
${AFFECTED_PACKAGES.join('\n') || 'None specified'}

${QA_DOCS ? `
## Project-Specific QA Rules

IMPORTANT: Apply these project-specific QA rules as PRIMARY testing criteria.

${QA_DOCS}
` : ''}
${E2E_DOCS ? `
## Project-Specific E2E Testing Rules

IMPORTANT: Apply these E2E testing rules when writing and running E2E tests.

${E2E_DOCS}
` : ''  /* E2E_DOCS loaded from options.e2eDocs (line 56) */}
")
```

**The agent will:**
1. **Navigate directly to APP_URL** (server is already running — started by check-start-env.js)
2. **Track progress incrementally** (call qa-progress.js at each step)
3. Run tests based on affected files (skip completed tests from resume info)
4. Take screenshots
5. Write report to REPORT_PATH
6. Handle infrastructure failures with MCP diagnostics (NEVER start a server)

---

## Examples

### Simple (one app)
```
/check-qa status-site
```
→ Launches qa-feature-tester for status-site with defaults

### With options (from /check)
```
/check-qa as-dashboard {"ticketId":"PROJ-856","reportPath":"$HOME/worktrees/tasks/PROJ-856/qa-as-dashboard.md","changesHash":"abc123","appUrl":"http://host.docker.internal:5178"}
```

### No arguments (auto-discover)
```
/check-qa
```
→ Runs `node scripts/get-affected.js main json`
→ Launches agent for each affected app

---

## Enforcement

Reports are validated by SubagentStop hook: `${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/agents/qa-feature-tester/validate-qa-report.js`

**Report output status:** The `write-qa-report.js` script sets the report `Status:` line to `APPROVED` (when agent passes PASS) or `NEEDS_WORK` (when agent passes FAIL, ACCESS_FAILED, or BLOCKED). Agents still use the input vocabulary (PASS/FAIL/ACCESS_FAILED/BLOCKED) — the script handles the translation.

**Blocked if:**
- Missing report file
- Missing `**Changes Hash:**` header
- Missing `## Playwright Verification` section
- No `mcp__playwright__` tool evidence
- Puppeteer scripts used instead of MCP
- No screenshots
- ACCESS_FAILED without MCP diagnostics

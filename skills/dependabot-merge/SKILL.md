---
name: dependabot-merge
description: Analyze and merge Dependabot PRs safely with CI validation
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite, AskUserQuestion, mcp__atlassian__jira_get_issue
user-invocable: true
---
# /dependabot-merge - Dependabot PR Merge Assistant

Analyze all Dependabot branches, categorize them by safety level, and merge them one-by-one with CI validation.

---

## Step 0: Create Dedicated Worktree

Create an isolated worktree for Dependabot operations to avoid disrupting current work.

```bash
cd ~/${REPO_NAME}
git fetch origin --prune

# Create worktree from main (use date-based naming to avoid conflicts)
WORKTREE_NAME="dependabot-merge-$(date +%Y%m%d)"
WORKTREE_PATH="../${REPO_NAME}-${WORKTREE_NAME}"

# Check if worktree already exists
if [ -d "$WORKTREE_PATH" ]; then
  echo "Worktree already exists at $WORKTREE_PATH"
  cd "$WORKTREE_PATH"
else
  git worktree add "$WORKTREE_PATH" origin/main --detach
  cd "$WORKTREE_PATH"

  # Setup credentials and config symlinks
  echo "Setting up worktree..."
  [ -d "../${REPO_NAME}/credentials" ] && cp -r ../${REPO_NAME}/credentials/* ./credentials/ 2>/dev/null || true
  [ -f "../${REPO_NAME}/.claude" ] && ln -sf ../${REPO_NAME}/.claude .claude 2>/dev/null || true
  [ -f "../${REPO_NAME}/.env" ] && cp ../${REPO_NAME}/.env .env 2>/dev/null || true

  echo "✅ Created worktree at $WORKTREE_PATH"
fi

# Verify we're in the right place
pwd
git status
```

**Why use a worktree?**
- Isolates Dependabot work from your current feature branch
- Allows checking out multiple Dependabot branches without stashing
- Easy cleanup after merges complete
- Prevents accidental commits to wrong branches

**Cleanup after done:**
```bash
# After all merges complete, remove the worktree
cd ~/${REPO_NAME}
git worktree remove "../${REPO_NAME}-${WORKTREE_NAME}" --force
git worktree prune
```

---

## Step 1: List and Analyze Dependabot PRs

```bash
# Already in the dedicated worktree from Step 0
git fetch origin --prune

# Get all dependabot PRs with details
gh pr list --author "app/dependabot" --state open --json number,title,headRefName,mergeable,statusCheckRollup,labels,createdAt,updatedAt --limit 50
```

---

## Step 2: Categorize Each PR

For each Dependabot PR, analyze and categorize:

### Category Definitions

**SAFE (Auto-merge candidates):**
- Patch version bumps (e.g., 1.0.1 → 1.0.2)
- Minor version bumps for well-tested packages (e.g., 1.0.0 → 1.1.0)
- Dev dependencies only (@types/*, eslint plugins, testing tools)
- CI is passing (all status checks green)
- No merge conflicts (mergeable: true)

**GROUPED (Must merge together):**
- Packages from the same ecosystem that share versions (vitest + @vitest/*)
- Dependabot grouped updates (branch contains `npm_and_yarn-` hash)
- Peer dependency pairs that must stay in sync
- Process atomically: merge all in group, or none

**NEEDS WORK (Fixable issues):**
- CI is failing but likely fixable (type errors, lint issues)
- Has merge conflicts that can be resolved
- Minor breaking changes that need code updates

**UNSAFE (Manual review required):**
- Major version bumps (e.g., 1.x → 2.x) for non-dev dependencies
- Security-critical packages (auth, crypto, database drivers)
- Core framework updates (react, express, vite, typescript)
- Multiple failing CI checks with unclear fixes

### Paired Package Detection

Detect packages that must be merged together:

```javascript
// Known package groups - merge atomically
const PACKAGE_GROUPS = {
  'vitest': ['vitest', '@vitest/coverage-v8', '@vitest/ui', '@vitest/browser'],
  'react': ['react', 'react-dom', '@types/react', '@types/react-dom'],
  'mui': ['@mui/material', '@mui/icons-material', '@mui/lab', '@emotion/react', '@emotion/styled'],
  'eslint': ['eslint', '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin'],
  'playwright': ['playwright', '@playwright/test'],
  'tanstack-query': ['@tanstack/react-query', '@tanstack/react-query-devtools'],
};

// Check if PR belongs to a group
function getPackageGroup(packageName) {
  for (const [group, packages] of Object.entries(PACKAGE_GROUPS)) {
    if (packages.some(p => packageName.includes(p))) {
      return group;
    }
  }
  return null;
}
```

When grouped packages are detected:
1. Identify all PRs in the group
2. Present them together in the analysis
3. Process them as a single atomic unit

### Analysis Commands

For each PR, gather:

```bash
# Get PR details
gh pr view <PR_NUMBER> --json title,body,headRefName,mergeable,statusCheckRollup,files

# Check version bump type
# Extract from title: "bump <package> from <old> to <new>"
# Parse semver to determine: patch, minor, or major

# Check CI status
gh pr checks <PR_NUMBER>

# Check if mergeable
gh pr view <PR_NUMBER> --json mergeable -q '.mergeable'

# Check changed files (to assess scope)
gh pr view <PR_NUMBER> --json files -q '.files[].path'
```

### Fetch Changelog for Review

For UNSAFE or major bumps, fetch changelog:

```bash
# Extract package name and repo from PR body
PACKAGE_NAME="vitest"  # parsed from PR title

# Try to fetch releases from GitHub
gh api "repos/vitest-dev/vitest/releases" --jq '.[0:3] | .[] | "## \(.tag_name)\n\(.body)\n"' 2>/dev/null || echo "No GitHub releases found"

# Alternative: Check npm for changelog link
npm view $PACKAGE_NAME repository.url homepage --json 2>/dev/null

# Or fetch CHANGELOG.md directly if repo is known
curl -s "https://raw.githubusercontent.com/vitest-dev/vitest/main/CHANGELOG.md" | head -100
```

### Version Bump Detection

Parse the PR title to determine bump type:

```
"bump X from 1.0.0 to 1.0.1" → PATCH (safe)
"bump X from 1.0.0 to 1.1.0" → MINOR (usually safe)
"bump X from 1.0.0 to 2.0.0" → MAJOR (unsafe for prod deps, needs-work for dev deps)
```

### Package Risk Assessment

**Low Risk (usually SAFE):**
- @types/* - TypeScript type definitions
- eslint-* - Linting tools
- prettier - Code formatting
- Testing libraries (vitest, jest, msw) - even major bumps

**Medium Risk (evaluate individually):**
- UI libraries (recharts, @mui/*)
- Utility libraries (lodash, date-fns)
- Build tools (vite, esbuild)

**High Risk (usually UNSAFE):**
- react, react-dom - Core framework
- express, fastify - Server framework
- typescript - Language version
- node-pg-migrate - Database migrations
- Authentication packages
- Database drivers

---

## Step 3: Present Analysis to User

Display categorized results:

```
═══════════════════════════════════════════════════════════════════════════════
                     DEPENDABOT PR ANALYSIS
═══════════════════════════════════════════════════════════════════════════════

SAFE TO MERGE (CI passing, patch/minor, no conflicts):
───────────────────────────────────────────────────────────────────────────────

1. PR #408 - bump dotenv from 16.6.1 to 17.2.3
   Branch: dependabot/npm_and_yarn/dotenv-17.2.3
   Type: MINOR bump | CI: ✅ Passing | Mergeable: ✅
   Risk: Low (env loading utility)

2. PR #407 - bump recharts from 3.5.1 to 3.6.0
   Branch: dependabot/npm_and_yarn/recharts-3.6.0
   Type: MINOR bump | CI: ✅ Passing | Mergeable: ✅
   Risk: Medium (UI library)


GROUPED (Must merge together - atomic):
───────────────────────────────────────────────────────────────────────────────

📦 Group: vitest (2 PRs)
   ├─ PR #406 - bump vitest from 3.2.4 to 4.0.17
   │  Type: MAJOR bump | CI: ❌ Failing | Mergeable: ✅
   │
   └─ PR #405 - bump @vitest/coverage-v8 from 3.2.4 to 4.0.17
      Type: MAJOR bump | CI: ❌ Failing | Mergeable: ✅

   Strategy: Fix vitest first, push, then merge both together
   Issue: TypeScript errors - API changes in v4


NEEDS WORK (CI failing or conflicts - can be fixed):
───────────────────────────────────────────────────────────────────────────────

(See GROUPED section above - vitest packages moved there)


UNSAFE (Manual review required - major changes):
───────────────────────────────────────────────────────────────────────────────

1. PR #399 - bump react-router from 7.8.2 to 7.12.0 in the npm_and_yarn group
   Branch: dependabot/npm_and_yarn/npm_and_yarn-e7552e82bb
   Type: MINOR bump | CI: ❓ Pending | Mergeable: ❓
   Risk: HIGH (core routing framework, Dependabot grouped update)
   Reason: react-router updates often have subtle breaking changes

   Changelog highlights:
   - v7.10.0: New preload API
   - v7.11.0: Route module changes
   - v7.12.0: Bug fixes


SUMMARY:
  Safe: X PRs
  Grouped: Y PRs (in Z groups)
  Needs Work: W PRs
  Unsafe: V PRs

═══════════════════════════════════════════════════════════════════════════════
```

---

## Step 4: Ask User for Action

Use `AskUserQuestion` tool:

```
What would you like to do with Dependabot PRs?
```

Options:
1. **Merge SAFE only (X PRs)** - Auto-merge all safe PRs with passing CI
2. **Merge SAFE + GROUPED (X+Y PRs)** - Merge safe PRs, then process grouped packages atomically
3. **Merge SAFE + GROUPED + fix NEEDS WORK** - Include PRs that need fixes
4. **Merge ALL including UNSAFE** - Process all PRs (with confirmation for unsafe)
5. **Custom selection** - Let me specify which PRs to process

If user selects "Custom selection", ask:
```
Enter PR numbers to process (comma-separated, e.g., "408,407,406"):
```

---

## Step 5: Process PRs One-by-One

For each PR in the selected list:

### 5.1: Check if Dependabot Rebased

Before processing, check if Dependabot has rebased the PR:

```bash
# Get current PR head SHA
gh pr view <PR_NUMBER> --json headRefOid -q '.headRefOid'

# Compare with what we analyzed
# If different, Dependabot rebased - re-check CI status
```

### 5.2: For SAFE PRs - Direct Merge

```bash
# Enable auto-merge (waits for CI automatically)
gh pr merge <PR_NUMBER> --squash --auto

# Monitor progress (auto will handle CI waiting)
echo "Auto-merge enabled for PR #<PR_NUMBER>. Will merge when CI passes."

# Check status periodically
gh pr view <PR_NUMBER> --json state,autoMergeRequest -q '{state: .state, autoMerge: .autoMergeRequest}'
```

### 5.3: For GROUPED PRs - Atomic Processing

```bash
# Example: vitest group (PR #406 + PR #405)

# Step 1: Checkout the primary package branch
git fetch origin dependabot/npm_and_yarn/vitest-4.0.17
git checkout dependabot/npm_and_yarn/vitest-4.0.17

# Step 2: Cherry-pick or merge the companion package changes
git fetch origin dependabot/npm_and_yarn/vitest/coverage-v8-4.0.17
git cherry-pick origin/dependabot/npm_and_yarn/vitest/coverage-v8-4.0.17

# Step 3: Fix any CI issues (both packages together)
pnpm install
pnpm lint --fix
pnpm typecheck
# Fix any errors...

# Step 4: Push combined changes
git push

# Step 5: Wait for CI on primary PR
gh pr checks <PRIMARY_PR_NUMBER> --watch

# Step 6: Merge primary PR (contains all changes)
gh pr merge <PRIMARY_PR_NUMBER> --squash

# Step 7: Close companion PR (changes already included)
gh pr close <COMPANION_PR_NUMBER> --comment "Merged as part of vitest group update in PR #<PRIMARY_PR_NUMBER>"
```

### 5.4: For NEEDS WORK PRs - Fix Then Merge

```bash
# Checkout the branch
git fetch origin <branch-name>
git checkout <branch-name>

# Identify the issue from CI logs
gh pr checks <PR_NUMBER>
gh run view <run-id> --log-failed

# Common fixes:
# 1. Type errors: Update types, add assertions
# 2. Lint errors: Run pnpm lint --fix
# 3. Test failures: Update test expectations
# 4. Conflicts: git rebase origin/main and resolve

# After fixing
git add .
git commit -m "fix: resolve CI issues for <package> update"
git push

# Enable auto-merge
gh pr merge <PR_NUMBER> --squash --auto
```

### 5.5: For UNSAFE PRs - Extra Confirmation

Before processing unsafe PRs, fetch and display changelog:

```bash
# Fetch changelog (example for react-router)
echo "Fetching changelog for react-router..."
gh api "repos/remix-run/react-router/releases" --jq '.[0:5] | .[] | "### \(.tag_name) (\(.published_at | split("T")[0]))\n\(.body | split("\n")[0:10] | join("\n"))\n"' 2>/dev/null | head -50
```

Then ask:

```
⚠️  UNSAFE PR: #<number> - <title>

This is a major version bump that may have breaking changes.

Changelog highlights:
[Fetched changelog entries]

Breaking changes detected:
- [List any breaking changes from changelog]

Proceed with caution?
- Yes, try to merge (will fix any issues)
- Skip this PR
- Abort remaining PRs
```

### 5.6: Ping Dependabot if Needed

After each successful merge, Dependabot will automatically rebase other PRs.
If the next PR in queue shows old commits:

```bash
# Check if PR needs rebase
MERGE_STATUS=$(gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus -q '{m: .mergeable, s: .mergeStateStatus}')
echo "Current status: $MERGE_STATUS"

# If stale or blocked, ping Dependabot to rebase
if [[ "$MERGE_STATUS" == *"BEHIND"* ]] || [[ "$MERGE_STATUS" == *"false"* ]]; then
  gh pr comment <PR_NUMBER> --body "@dependabot rebase"
  echo "Requested Dependabot rebase..."
fi
```

**Rebase waiting strategy** (choose based on queue size):

**Option A: Wait with timeout (for small queues, ≤3 PRs)**
```bash
# Wait up to 10 minutes, checking every 60 seconds
MAX_WAIT=10
for i in $(seq 1 $MAX_WAIT); do
  sleep 60
  STATUS=$(gh pr view <PR_NUMBER> --json mergeable -q '.mergeable')
  CHECKS=$(gh pr view <PR_NUMBER> --json statusCheckRollup -q '.statusCheckRollup | length')

  if [ "$STATUS" = "MERGEABLE" ] && [ "$CHECKS" -gt 0 ]; then
    echo "✅ PR rebased and CI started"
    break
  fi

  echo "⏳ Waiting for Dependabot rebase... ($i/$MAX_WAIT min)"

  # Check if Dependabot responded with an error
  LAST_COMMENT=$(gh pr view <PR_NUMBER> --json comments -q '.comments[-1].body // ""')
  if [[ "$LAST_COMMENT" == *"error"* ]] || [[ "$LAST_COMMENT" == *"conflict"* ]]; then
    echo "❌ Dependabot reported an issue"
    break
  fi
done

if [ "$STATUS" != "MERGEABLE" ]; then
  echo "⚠️  Timeout waiting for rebase - will try manual fallback"
fi
```

**Option B: Continue without waiting (for large queues, >3 PRs) [RECOMMENDED]**
```bash
# Don't block - ping and move on, verify at end of batch
gh pr comment <PR_NUMBER> --body "@dependabot rebase"
echo "⏩ Rebase requested, continuing to next PR..."
echo "   Will re-check this PR at the end of the batch"

# Track for later verification
DEFERRED_PRS+=($PR_NUMBER)
```

**Option C: Manual rebase fallback (if Dependabot unresponsive after 5 min)**
```bash
echo "⚠️  Dependabot unresponsive, attempting manual rebase..."

git fetch origin <branch-name>
git checkout <branch-name>
git fetch origin main
git rebase origin/main

if [ $? -eq 0 ]; then
  git push --force-with-lease
  echo "✅ Manual rebase successful"
else
  echo "❌ Rebase has conflicts - skipping this PR"
  git rebase --abort
  SKIPPED_PRS+=($PR_NUMBER)
fi
```

**Recommended approach:** Use Option B for batches of 3+ PRs. Process all SAFE PRs first (they won't need rebasing after merge), then circle back to verify any deferred PRs at the end of the batch.

### 5.7: Track Progress

Use TodoWrite to track each PR:

```
1. [completed] PR #408 - dotenv 17.2.3 (merged)
2. [in_progress] PR #407 - recharts 3.6.0 (waiting for CI)
3. [pending] PR #406 + #405 - vitest group (atomic)
4. [pending] PR #399 - react-router (unsafe, needs confirmation)
```

---

## Step 6: Post-Merge Verification

After all selected PRs are merged:

### 6.1: Verify Lockfile Integrity

```bash
cd ~/${REPO_NAME}
git checkout main
git pull origin main

# Verify lockfile is coherent
echo "Verifying lockfile integrity..."
pnpm install --frozen-lockfile

if [ $? -eq 0 ]; then
  echo "✅ Lockfile is valid"
else
  echo "❌ Lockfile integrity issue detected!"
  echo "Running pnpm install to regenerate..."
  pnpm install

  # Check if lockfile changed
  if ! git diff --quiet pnpm-lock.yaml; then
    echo "⚠️  Lockfile needed regeneration. Creating fix commit..."
    git add pnpm-lock.yaml
    git commit -m "fix(deps): regenerate lockfile after dependency updates"
    git push origin main
  fi
fi
```

### 6.2: Wait for CI on Main

```bash
# Check if any CI runs are in progress on main
gh run list --branch=main --limit=3 --json status,conclusion,name,databaseId

# Wait for the latest run to complete
LATEST_RUN=$(gh run list --branch=main --limit=1 --json databaseId -q '.[0].databaseId')
gh run watch $LATEST_RUN
```

### 6.3: Run Health Checks

```bash
# Run make health for 3 minutes, checking every 30 seconds
echo "Starting health monitoring (3 minutes)..."

for i in {1..6}; do
  echo "=== Health Check $i/6 ($(date)) ==="
  make health 2>&1 || echo "Health check returned non-zero"

  if [ $i -lt 6 ]; then
    echo "Waiting 30 seconds..."
    sleep 30
  fi
done

echo "Health monitoring complete"
```

### 6.4: Check for Regressions

```bash
# Check recent CI runs on main
gh run list --branch=main --limit=5 --json conclusion,name,databaseId,createdAt

# If any failures, alert user
```

---

## Step 7: Rollback Strategy

If health checks fail or regressions are detected:

### 7.1: Identify Problem Commits

```bash
# List recent merges on main
git log --oneline --merges -10

# Find the problematic merge
gh run list --branch=main --json conclusion,headSha,name -q '.[] | select(.conclusion == "failure")'
```

### 7.2: Revert Options

**Option A: Revert single PR (if one PR caused the issue)**
```bash
# Find the merge commit for the problematic PR
MERGE_COMMIT=$(git log --oneline --grep="PR #<number>" -1 --format="%H")

# Revert it
git revert $MERGE_COMMIT -m 1
git push origin main

# Re-open the Dependabot PR
gh pr reopen <PR_NUMBER>
gh pr comment <PR_NUMBER> --body "Reverted due to regression. Needs investigation before re-merging."
```

**Option B: Revert multiple PRs (batch rollback)**
```bash
# Find commit before the merge batch started
SAFE_COMMIT=$(git log --oneline -20 | grep -v "dependabot" | head -1 | cut -d' ' -f1)

# Create a revert branch
git checkout -b revert-dependabot-batch
git revert --no-commit $SAFE_COMMIT..HEAD
git commit -m "revert: rollback Dependabot batch due to regressions"
git push origin revert-dependabot-batch

# Create PR for the revert
gh pr create --title "revert: rollback Dependabot batch" --body "Reverting recent dependency updates due to regressions detected in health checks."
```

**Option C: Emergency hotfix**
```bash
# If revert is complex, create hotfix branch
git checkout -b hotfix/dependabot-regression
# ... fix the issue ...
git push origin hotfix/dependabot-regression
gh pr create --title "fix: resolve regression from dependency updates" --body "..."
```

### 7.3: Post-Rollback Actions

```bash
# Re-enable Dependabot PRs that were closed
for PR_NUM in <list-of-reverted-prs>; do
  gh pr reopen $PR_NUM
  gh pr comment $PR_NUM --body "@dependabot rebase

This PR was reverted due to a regression. Please investigate before re-merging."
done
```

---

## Step 8: Final Summary and Cleanup

### 8.1: Cleanup Worktree

```bash
# Return to main worktree
cd ~/${REPO_NAME}

# Remove the temporary dependabot worktree
WORKTREE_NAME="dependabot-merge-$(date +%Y%m%d)"
git worktree remove "../${REPO_NAME}-${WORKTREE_NAME}" --force 2>/dev/null || true
git worktree prune

echo "✅ Worktree cleaned up"
git worktree list
```

### 8.2: Display Summary

```
═══════════════════════════════════════════════════════════════════════════════
                     DEPENDABOT MERGE COMPLETE
═══════════════════════════════════════════════════════════════════════════════

MERGED SUCCESSFULLY:
───────────────────────────────────────────────────────────────────────────────
✅ PR #408 - dotenv 16.6.1 → 17.2.3
✅ PR #407 - recharts 3.5.1 → 3.6.0
✅ PR #406 + #405 - vitest group 3.2.4 → 4.0.17 (required fixes)

SKIPPED:
───────────────────────────────────────────────────────────────────────────────
⏭️  PR #399 - react-router 7.8.2 → 7.12.0 (user skipped - unsafe)

FAILED:
───────────────────────────────────────────────────────────────────────────────
❌ (none)

VERIFICATION:
───────────────────────────────────────────────────────────────────────────────
✅ Lockfile integrity verified (pnpm install --frozen-lockfile passed)
✅ CI on main: All checks passed
✅ Health checks: 6/6 passed
✅ No regressions detected

CLEANUP:
───────────────────────────────────────────────────────────────────────────────
✅ Worktree removed: ${REPO_NAME}-dependabot-merge-YYYYMMDD

REMAINING DEPENDABOT PRs: 1
───────────────────────────────────────────────────────────────────────────────
• PR #399 - react-router (skipped, requires manual review)

ROLLBACK COMMAND (if needed):
───────────────────────────────────────────────────────────────────────────────
git revert <merge-commit> -m 1 && git push origin main

═══════════════════════════════════════════════════════════════════════════════
```

---

## Error Handling

### CI Failure During Merge

If CI fails after attempting fixes:

```
❌ PR #<number> CI still failing after fixes

Options:
1. Skip this PR and continue
2. Abort remaining PRs
3. Force merge anyway (not recommended)
```

### Merge Conflict

If conflicts arise:

```bash
# Try automatic rebase
git fetch origin main
git rebase origin/main

# If conflicts, show them
git diff --name-only --diff-filter=U

# Ask user for guidance
```

### Dependabot Not Responding

If Dependabot doesn't rebase within 5 minutes:

```
⚠️  Dependabot has not rebased PR #<number> after 5 minutes.

Options:
1. Manually rebase the branch
2. Skip this PR
3. Continue without rebase (may have conflicts)
```

---

## Quick Reference

| Bump Type | Default Category | Override Conditions |
|-----------|------------------|---------------------|
| Patch | SAFE | CI failing → NEEDS WORK |
| Minor | SAFE | High-risk package → UNSAFE |
| Major | NEEDS WORK (dev) | Prod dependency → UNSAFE |

| Package Pattern | Risk Level | Notes |
|-----------------|------------|-------|
| @types/* | Low | Types only |
| eslint-*, prettier | Low | Dev tooling |
| vitest, jest, @vitest/* | Low | Test framework (group together) |
| @mui/*, recharts | Medium | UI libraries |
| react, react-router | High | Core framework |
| express, typescript | High | Runtime/language |
| Database drivers, auth | High | Security-critical |

| CI Status | Action |
|-----------|--------|
| ✅ All passing | Enable auto-merge |
| ❌ Failing | Attempt fix or skip |
| ⏳ Pending | Wait up to 10 minutes |
| ⚠️  Some skipped | Review skipped checks |

| Package Group | Members |
|--------------|---------|
| vitest | vitest, @vitest/coverage-v8, @vitest/ui |
| react | react, react-dom, @types/react, @types/react-dom |
| mui | @mui/material, @mui/icons-material, @emotion/* |
| eslint | eslint, @typescript-eslint/* |
| playwright | playwright, @playwright/test |

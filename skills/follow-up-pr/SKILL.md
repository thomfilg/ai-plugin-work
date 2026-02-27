---
name: follow-up-pr
description: Monitor PR CI status, auto-fix failures, and retry until passing (max 10 attempts)
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite, AskUserQuestion, Skill
---

# /follow-up-pr - PR CI Monitor and Auto-Fixer

Monitor the current PR's CI status, automatically diagnose and fix failures, and retry until CI passes.

---

## Configuration

```
MAX_ATTEMPTS=10
WAIT_INTERVAL_SECONDS=60
```

**Strategy:** Start working immediately on first failure - don't wait for all checks.

---

## Step 1: Initialize Tracking

Create a summary tracker:

```javascript
const summary = {
  prNumber: null,
  prUrl: null,
  branch: null,
  startTime: new Date().toISOString(),
  attempts: [],
  fixes: [],
  finalStatus: null
};
```

---

## Step 2: Get Current PR Info

```bash
# Get current branch
BRANCH=$(git branch --show-current)

# Get PR number, URL, and conflict status in one call
gh pr view --json number,url,title,headRefName,mergeable,mergeStateStatus
```

If no PR exists for the current branch, inform the user and exit.

### 2.1 Check for Merge Conflicts

From the PR info already fetched above, check the `mergeable` and `mergeStateStatus` fields.

**If `mergeable` is `"CONFLICTING"` or `mergeStateStatus` is `"DIRTY"`:**
1. Fetch latest main: `git fetch origin main`
2. Attempt rebase: `git rebase origin/main`
3. If conflicts occur:
   - List conflicting files: `git diff --name-only --diff-filter=U`
   - Read each conflicting file and resolve conflicts intelligently
   - Follow CLAUDE.md merge conflict rules (check Jira context for the conflicting commit if applicable)
   - After resolving: `git add <resolved-files> && git rebase --continue`
4. Force push the rebased branch: `git push --force-with-lease`
5. Log the conflict resolution in `summary.fixes`
6. Wait 30 seconds for GitHub to recalculate mergeability, then continue to Step 3

**If `mergeable` is `"MERGEABLE"`:** Continue to Step 3.

---

## Step 3: Check CI Status Loop

For each attempt (1 to MAX_ATTEMPTS):

### 3.1 Check CI Status and Conflicts

```bash
# Get PR checks status
gh pr checks <PR_NUMBER> --watch=false

# Also get the overall status AND conflict state
gh pr view <PR_NUMBER> --json statusCheckRollup,mergeable,mergeStateStatus
```

### 3.2 Evaluate Status

**FIRST — Check for merge conflicts:**
If `mergeable` is `"CONFLICTING"` or `mergeStateStatus` is `"DIRTY"`, resolve conflicts using the same process from Step 2.1 before evaluating CI status. Conflicts can appear mid-loop when main is updated by other PRs merging.

**If ALL checks pass AND no conflicts:**
- Record final status as "PASSED"
- Go to Step 5 (Success Summary)

**If ANY checks FAILED (even if others are still running):**
- Log which checks failed
- **DO NOT WAIT** - immediately go to Step 4 (Diagnose and Fix)
- Run the failing checks locally and fix them while CI continues

**If ALL checks are still RUNNING (none failed yet):**
- Log: "CI is still running, waiting 60 seconds..."
- Wait 60 seconds (use: `sleep 60`)
- Continue to next attempt

---

## Step 4: Diagnose and Fix Failures

### 4.1 Get Failure Details

**CRITICAL: Read ALL failed steps systematically before diagnosing.**

```bash
# Get the failed job logs
gh run view <RUN_ID> --job <JOB_ID> --log-failed

# Or get recent run with failures
gh run list --branch <BRANCH> --status failure --limit 1 --json databaseId,conclusion,name
gh run view <RUN_ID> --log-failed | tail -200
```

**Systematic Diagnosis Checklist:**
1. List ALL failed checks from `gh pr checks` output
2. Read EACH failed step's output - don't assume based on the first failure
3. Identify failure dependencies (e.g., tests fail → coverage not generated → coverage check fails)
4. Fix the ROOT CAUSE, not the cascading failures

```
╔══════════════════════════════════════════════════════════════════════╗
║  🛑 MANDATORY: ANY coverage failure → /test-coordination             ║
║                                                                      ║
║  This includes ALL of these CI failure messages:                     ║
║  • "Check modified files coverage"                                   ║
║  • "Please add tests to maintain or improve coverage"                ║
║  • "coverage decrease"                                               ║
║  • "check-coverage-decrease"                                         ║
║  • Any vitest-coverage-report-action failure                         ║
║  • ANY log line mentioning "coverage" + failure/error                ║
║                                                                      ║
║  DO NOT:                                                             ║
║  ❌ Investigate the CI config                                        ║
║  ❌ Argue it's "pre-existing" or "infrastructure"                    ║
║  ❌ Rationalize that "real tests passed"                             ║
║  ❌ Try to fix glob patterns or CI yaml                              ║
║                                                                      ║
║  DO:                                                                 ║
║  ✅ Run Skill(test-coordination): <TICKET_ID> IMMEDIATELY            ║
║  ✅ Then push and re-check CI                                        ║
║                                                                      ║
║  If CI is red, it's YOUR problem. Fix it. Don't explain it away.    ║
╚══════════════════════════════════════════════════════════════════════╝
```

### 4.2 Common Failure Patterns and Fixes

**Lint failures:**
- Run `pnpm lint` locally to see errors
- Fix lint issues in the relevant files
- Commit with message: `fix(lint): resolve linting errors`

**TypeScript errors:**
- Run `pnpm typecheck` locally
- Fix type errors
- Commit with message: `fix(types): resolve TypeScript errors`

**Test failures:**
- Run `pnpm test` locally to reproduce
- Analyze test output and fix the failing test or code
- Commit with message: `fix(tests): resolve failing tests`

**Build failures:**
- Run `pnpm build` locally
- Fix build configuration or code issues
- Commit with message: `fix(build): resolve build errors`

**GitHub Actions workflow errors:**
- Check workflow YAML syntax
- Run `actionlint` if available
- Commit with message: `fix(ci): correct workflow configuration`

### 4.3 Coverage Failures - Use /test-coordination (MANDATORY)

**If ANY coverage-related check fails — including "coverage decrease", "modified files coverage", or coverage action errors — you MUST run /test-coordination. No exceptions. No investigation. No arguing.**

```
Skill(test-coordination): <TICKET_ID>
```

This command will:
1. Find modified source files and their corresponding test files
2. Launch `/tests-review` and `/tests-create` in parallel
3. Iterate until coverage rating >= 9 or stabilized
4. Commit enhanced tests automatically

**After /test-coordination completes:**
1. Push: `git push`
2. Continue to next attempt (return to Step 3)

**Common coverage failure scenarios (for reference only — action is always the same):**
- "No coverage data" for all files = tests failed, coverage JSON wasn't generated. Fix tests first, THEN run /test-coordination.
- Specific files below 80% = /test-coordination handles this.
- "Please add tests to maintain or improve coverage" = coverage decreased vs main. /test-coordination handles this.
- Coverage report action ENOENT/glob errors = may be masking the real issue. Run /test-coordination anyway.

### 4.4 Apply Fix (Non-Coverage Issues)

1. Make the necessary code changes
2. Stage changes: `git add <files>`
3. Commit using commit-writer agent with "autonomous" flag
4. Push: `git push`
5. Record the fix in summary.fixes array
6. Continue to next attempt (return to Step 3)

---

## Step 5: Generate Summary

### Success Summary (CI Passed)

```markdown
## PR Follow-up Summary

**PR:** #<NUMBER> - <TITLE>
**Branch:** <BRANCH>
**Final Status:** PASSED

### Timeline
- Started: <START_TIME>
- Completed: <END_TIME>
- Total Attempts: <N>

### Fixes Applied
<For each fix in summary.fixes>
- Attempt <N>: <COMMIT_MESSAGE>
  - Issue: <WHAT_FAILED>
  - Resolution: <WHAT_WAS_FIXED>
</For each>

### CI Checks (Final)
<List all passing checks>

**Result:** PR is ready for review/merge!
```

### Failure Summary (Max Attempts Reached)

```markdown
## PR Follow-up Summary

**PR:** #<NUMBER> - <TITLE>
**Branch:** <BRANCH>
**Final Status:** FAILED (after 10 attempts)

### Timeline
- Started: <START_TIME>
- Stopped: <END_TIME>
- Total Attempts: 10

### Attempts Log
<For each attempt>
- Attempt <N>: <STATUS>
  - Failed checks: <LIST>
  - Fix attempted: <DESCRIPTION>
</For each>

### Persistent Failures
<List checks that continue to fail>

### Fixes Applied
<For each fix in summary.fixes>
- <COMMIT_MESSAGE>: <DESCRIPTION>
</For each>

### Current Error
<Last error message from CI>

**Need clarification on:**
1. <Specific question about the failure>
2. <Alternative approaches to consider>
```

---

## Step 6: Handle Max Attempts Exceeded

If 10 attempts are reached without success:

1. Generate the failure summary
2. Use AskUserQuestion tool to ask for clarification:
   - "The PR CI has failed 10 times. What would you like me to try?"
   - Options:
     - "Continue trying with a different approach"
     - "Skip this check and proceed"
     - "Abandon and revert changes"
     - "Other (explain)"

---

## Important Notes

- **Always use commit-writer agent** for creating commits (with "autonomous" flag)
- **Never push directly to main** - this command only works on feature branches
- **Log every action** in the summary for user visibility
- **Be conservative with fixes** - don't make unrelated changes
- **If unsure about a fix**, ask the user before applying
- **Preserve existing functionality** - run local tests before pushing fixes

---

## Example Invocation

User: `/follow-up-pr`

Claude will:
1. Identify current PR (#463)
2. Check CI status (failing: unit-tests)
3. Diagnose: coverage report glob pattern issue
4. Fix: update glob pattern in ci.yml
5. Commit and push
6. Wait 3 minutes, check again
7. If passing, report success
8. If failing, diagnose next issue and repeat

---
name: follow-up-pr
description: Monitor PR CI status and review comments, auto-fix failures and address feedback, retry until passing (max 10 attempts)
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite, AskUserQuestion, Skill
---

# /follow-up-pr - PR CI Monitor, Review Handler, and Auto-Fixer

Monitor the current PR's CI status and review comments (from humans and AI reviewers), automatically diagnose and fix failures, address review feedback, and retry until CI passes and reviews are resolved.

---

## Configuration

```
MAX_ATTEMPTS=10
WAIT_INTERVAL_SECONDS=60
FOLLOW_UP_PR_POLL_REVIEWS=true   # Set to false in .env to disable review polling
```

**Strategy:** Start working immediately on first failure — don't wait for all checks.

**Review polling** is enabled by default. To disable it per-repository, set `FOLLOW_UP_PR_POLL_REVIEWS=false` in the `.env` file. When disabled, pass `--no-reviews` to the monitor script.

---

## Step 1: Run the Monitor Script

The `scripts/follow-up-pr.js` script handles all deterministic polling (CI checks, review fetching, bot review detection, state persistence). Run it first to get the current status:

```bash
# Determine script path (plugin root or project root)
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SCRIPT_PATH="$PLUGIN_ROOT/scripts/follow-up-pr.js"

# Build flags
REVIEW_FLAG=""
if [ "${FOLLOW_UP_PR_POLL_REVIEWS:-true}" = "false" ]; then
  REVIEW_FLAG="--no-reviews"
fi

# Single check (don't let the script loop — we handle the loop with fixes)
node "$SCRIPT_PATH" --once $REVIEW_FLAG 2>&1
```

### 1.1 Interpret Exit Codes

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| **0** | CI passed, reviews clear, no conflicts | Go to Step 6 (Success Summary) |
| **1** | Failures detected (CI failed, actionable reviews, or conflicts) | Read the output, then go to Step 2 |
| **2** | Error (no PR found, gh CLI failed) | Inform user and exit |

### 1.2 Read the State File

The script persists state to `/tmp/follow-up-pr-<repo>-<PR_NUMBER>.json`. Read it for structured data:

```bash
cat /tmp/follow-up-pr-*-<PR_NUMBER>.json
```

The state file contains: `prNumber`, `prUrl`, `branch`, `startTime`, `attempts[]`, and `finalStatus`.

---

## Step 2: Triage the Script Output

Parse the script's terminal output to determine what needs fixing:

### 2.1 CI Failures
If the output shows `CI: FAILING`:
- Note the failed check names and their categories (shown in `[brackets]`)
- Go to Step 4 (Diagnose and Fix Failures)

### 2.2 Merge Conflicts
If the output shows `CONFLICTS: Merge conflicts detected`:
1. Fetch latest main: `git fetch origin main`
2. Attempt rebase: `git rebase origin/main`
3. If conflicts occur:
   - List conflicting files: `git diff --name-only --diff-filter=U`
   - Read each conflicting file and resolve conflicts intelligently
   - After resolving: `git add <resolved-files> && git rebase --continue`
4. Force push: `git push --force-with-lease`
5. Return to Step 1 (re-run script)

### 2.3 Actionable Reviews
If the output shows `Reviews: N actionable`:
- Note reviewer names, states, file paths and comment previews
- Go to Step 5 (Address Review Feedback)

### 2.4 Pending Bot Reviews
If the output shows `Reviews: Awaiting bot reviews`:
- Wait 60 seconds, then return to Step 1 (re-run script)

---

## Step 3: Loop Until Resolved

After fixing issues (Steps 4 or 5), push and re-run the monitor:

```bash
git push
node "$SCRIPT_PATH" --once $REVIEW_FLAG 2>&1
```

Repeat this loop up to MAX_ATTEMPTS (10) times. If the script exits 0, go to Step 6.

**Important:** The script handles all the polling logic. You only need to:
1. Run the script (Step 1)
2. Fix what it reports (Steps 4/5)
3. Push and re-run (Step 3)

---

## Step 5: Address Review Feedback

### 5.1 Read and Understand Feedback

For each actionable review comment:

1. Read the comment body and understand what change is requested
2. If it's an inline comment, read the referenced file and line(s)
3. Group related comments (e.g., multiple comments about the same pattern)

### 5.2 Apply Review Fixes

For each group of related feedback:

1. Make the requested code changes
2. Stage changes: `git add <files>`
3. Commit using commit-writer agent with "autonomous" flag
   - Use message format: `fix(review): <description of what was addressed>`
4. Record in `summary.reviewsAddressed`:
   ```javascript
   { author: "<reviewer>", comment: "<summary>", fix: "<what was changed>" }
   ```

### 5.3 Push and Re-enter Loop

1. Push: `git push`
2. Log the review fixes in `summary.fixes`
3. Return to Step 1 (re-run monitor script to re-check CI and reviews)

**Important notes for review handling:**
- **If a review comment is ambiguous or you're unsure how to address it**, use AskUserQuestion to ask the user for guidance
- **Never dismiss or resolve review threads** — let the reviewer verify your fix
- **If the same reviewer keeps requesting changes**, consider asking the user if they want to continue or discuss directly with the reviewer
- **After addressing reviews**, the reviewer may add new comments — that's why we re-enter the loop

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
2. Push and return to Step 1 (re-run the monitor script)

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
6. Push and return to Step 1 (re-run the monitor script)

---

## Step 6: Generate Summary

### Success Summary (CI Passed, Reviews Resolved)

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

### Reviews Addressed
<For each review in summary.reviewsAddressed>
- @<AUTHOR>: "<COMMENT_SUMMARY>"
  - Fix: <WHAT_WAS_CHANGED>
</For each>
<If no reviews addressed: "No review comments required changes.">

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

### Reviews Addressed
<For each review in summary.reviewsAddressed>
- @<AUTHOR>: "<COMMENT_SUMMARY>" → <FIX>
</For each>

### Unresolved Review Comments
<List any review comments that could not be addressed>

### Current Error
<Last error message from CI>

**Need clarification on:**
1. <Specific question about the failure>
2. <Alternative approaches to consider>
```

---

## Step 7: Handle Max Attempts Exceeded

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
1. Run `node scripts/follow-up-pr.js --once` → exit 1 (CI failing: unit-tests)
2. Diagnose: coverage report glob pattern issue
3. Fix: update glob pattern in ci.yml
4. Commit and push
5. Re-run script → exit 1 (CI now passes, but 2 inline review comments)
6. Address review feedback, commit and push
7. Re-run script → exit 0 (CI passing, reviews clear)
8. Report success with all fixes and reviews addressed

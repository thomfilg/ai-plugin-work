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

**Review polling** is enabled by default. To disable it per-repository, set `FOLLOW_UP_PR_POLL_REVIEWS=false` in the `.env` file. When disabled, the command only monitors CI status and skips Steps 3.3–3.4 and Step 5 entirely.

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
  reviewsAddressed: [],    // review comments that were addressed
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
- If `FOLLOW_UP_PR_POLL_REVIEWS` is enabled, go to Step 3.3 (Poll Review Comments)
- If review polling is disabled OR no actionable reviews remain, record final status as "PASSED" and go to Step 6 (Success Summary)

**If ANY checks FAILED (even if others are still running):**
- Log which checks failed
- **DO NOT WAIT** - immediately go to Step 4 (Diagnose and Fix)
- Run the failing checks locally and fix them while CI continues

**If ALL checks are still RUNNING (none failed yet):**
- Log: "CI is still running, waiting 60 seconds..."
- Wait 60 seconds (use: `sleep 60`)
- Continue to next attempt

### 3.3 Poll Review Comments

**Skip this step if `FOLLOW_UP_PR_POLL_REVIEWS=false`.** Check the config:
```bash
# Read from .env or environment — defaults to true
echo "${FOLLOW_UP_PR_POLL_REVIEWS:-true}"
```

After CI passes (or while waiting for CI), check for PR review comments from humans or AI reviewers.

```bash
# Get all PR reviews (approved, changes_requested, commented)
gh pr view <PR_NUMBER> --json reviews --jq '.reviews[] | {author: .author.login, state: .state, body: .body, submittedAt: .submittedAt}'

# Get inline review comments (code-level feedback)
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments --jq '.[] | {author: .user.login, path: .path, line: .line, body: .body, created_at: .created_at, in_reply_to_id: .in_reply_to_id}'

# Get general PR conversation comments
gh pr view <PR_NUMBER> --json comments --jq '.comments[] | {author: .author.login, body: .body, createdAt: .createdAt}'
```

**Derive `{owner}/{repo}` from:**
```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

### 3.4 Evaluate Review Comments

**Classify each comment/review:**

1. **CHANGES_REQUESTED reviews** — These MUST be addressed. Go to Step 5 (Address Review Feedback).
2. **Inline code comments** (not replies to your own comments) — Actionable feedback on specific lines. Go to Step 5.
3. **General conversation comments** — Check if they contain actionable requests (e.g., "please rename X", "can you add Y"). If actionable, go to Step 5.
4. **APPROVED reviews** — No action needed. Log the approval.
5. **COMMENTED reviews with no actionable content** (e.g., "looks good", "nice work") — No action needed.

**Filtering rules:**
- **Ignore your own comments** — Filter out comments from the bot/author who created the PR
- **Ignore already-addressed comments** — Track which comments have been addressed in `summary.reviewsAddressed` by their ID/timestamp. Skip those.
- **Prioritize CHANGES_REQUESTED** — Address these before general comments
- **Treat AI reviewer comments the same as human comments** — Common AI reviewers include bots like `github-actions[bot]`, `copilot`, `coderabbitai`, `codeclimate`, etc. Their feedback is equally actionable.

**If no actionable reviews remain:**
- Record final status as "PASSED"
- Go to Step 6 (Success Summary)

**If actionable reviews exist:**
- Log: "Found <N> actionable review comments to address"
- Go to Step 5 (Address Review Feedback)

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
3. Return to Step 3 (re-check CI since new commits may trigger new runs, and re-poll reviews for new feedback)

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
1. Identify current PR (#463)
2. Check CI status (failing: unit-tests)
3. Diagnose: coverage report glob pattern issue
4. Fix: update glob pattern in ci.yml
5. Commit and push
6. Wait, check again — CI now passes
7. Poll review comments — finds 2 inline comments from reviewer
8. Address review feedback, commit and push
9. Re-check CI (still passing) and re-poll reviews (no new comments)
10. Report success with all fixes and reviews addressed

---
name: follow-up-pr
description: Monitor PR CI status and review comments, auto-fix failures and address feedback, retry until passing (max 10 attempts)
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite, AskUserQuestion, Skill
---

# /follow-up-pr - PR CI Monitor, Review Handler, and Auto-Fixer

Monitor the current PR's CI status and review comments (from humans and AI reviewers), automatically diagnose and fix failures, address review feedback, and retry until CI passes and reviews are resolved.

```
╔══════════════════════════════════════════════════════════════════════╗
║  COMPLETION RULE:                                                    ║
║                                                                      ║
║  This workflow is NOT complete until the script outputs:             ║
║                                                                      ║
║    ═══════════════════════════════════════                            ║
║      PR READY TO REVIEW                                              ║
║    ═══════════════════════════════════════                            ║
║                                                                      ║
║  If you do NOT see "PR READY TO REVIEW" → keep running the script.  ║
║  Fix what it reports, push, and run the script AGAIN.               ║
║  Repeat as many times as needed. There is no shortcut.              ║
║                                                                      ║
║  You CANNOT declare /follow-up-pr complete without this output.     ║
╚══════════════════════════════════════════════════════════════════════╝
```

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

The `scripts/follow-up-pr.js` script handles all deterministic polling (CI checks, review fetching, bot review detection, state persistence). It loops internally, waiting 60s between attempts, so **YOU do not need to manage any loop or sleep**. The script exits only when there is something actionable or when all checks pass.

```
╔══════════════════════════════════════════════════════════════════════╗
║  CRITICAL: NEVER use --once flag here.                              ║
║                                                                      ║
║  The script's built-in loop is the WHOLE POINT — it waits for       ║
║  pending CI checks so YOU don't consume context polling manually.   ║
║                                                                      ║
║  --once is ONLY for debugging/manual terminal use, NEVER in this    ║
║  skill workflow.                                                     ║
╚══════════════════════════════════════════════════════════════════════╝
```

```bash
# Determine script path (plugin root or project root)
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
SCRIPT_PATH="$PLUGIN_ROOT/scripts/follow-up-pr.js"

# Build flags
REVIEW_FLAG=""
if [ "${FOLLOW_UP_PR_POLL_REVIEWS:-true}" = "false" ]; then
  REVIEW_FLAG="--no-reviews"
fi

# Let the script loop and wait for CI — do NOT add --once
node "$SCRIPT_PATH" $REVIEW_FLAG 2>&1
```

### 1.1 Interpret Exit Codes

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| **0** | "PR READY TO REVIEW" — CI passed, no blocking reviews, no conflicts | Go to Step 6 (Success Summary). Workflow DONE. |
| **1** | Failures detected (CI failed, blocking reviews, or conflicts) | Read output → Step 2 → fix → push → **run script AGAIN** |
| **2** | Error (no PR found, gh CLI failed) | Inform user and exit |

**Exit 1 means: fix the issue, push, and run the script AGAIN. Keep doing this until you get exit 0.**

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

### 2.3 Blocking Reviews
If the output shows `Reviews: N BLOCKING`:
- These are medium/high priority comments that MUST be addressed
- Note reviewer names, priority tags ([HIGH] or [MEDIUM]), file paths, and comment previews
- Go to Step 5 (Address Review Feedback)
- **Non-blocking reviews** (nitpicks/low priority) are shown as informational but do NOT block "PR READY TO REVIEW"

### 2.4 Pending Bot Reviews
If the output shows `Reviews: Awaiting bot reviews`:
- The script handles waiting automatically (it loops internally)
- If you used the script correctly (without --once), it will wait and re-check

---

## Step 3: Loop Until "PR READY TO REVIEW"

After fixing issues (Steps 4 or 5), push and re-run the monitor:

```bash
git push
# Do NOT use --once — let the script wait for CI to finish
node "$SCRIPT_PATH" $REVIEW_FLAG 2>&1
```

```
╔══════════════════════════════════════════════════════════════════════╗
║  YOU MUST KEEP RUNNING THIS LOOP:                                    ║
║                                                                      ║
║  1. Run script → reads exit code                                     ║
║  2. Exit 1? → fix the issue → push → go to 1                       ║
║  3. Exit 0? → "PR READY TO REVIEW" appeared → DONE                 ║
║                                                                      ║
║  Run the script as many times as needed (up to 10 attempts).        ║
║  Each run, the script waits for CI internally — you just fix and    ║
║  re-run. There is NO shortcut. Do NOT stop early.                   ║
╚══════════════════════════════════════════════════════════════════════╝
```

**The script handles all polling/waiting internally. Your job is simple:**
1. Run the script (Step 1) — it waits for pending CI automatically
2. Fix what it reports (Steps 4/5)
3. Push and re-run (Step 3) — it waits for CI again
4. **Repeat until the script outputs "PR READY TO REVIEW" (exit 0)**

---

## Step 5: Address Review Feedback

### Review Priority System

The script automatically classifies review comments by priority:

| Reviewer | Blocking (must fix) | Non-blocking (ignore) |
|----------|--------------------|-----------------------|
| **Cursor** (`cursor-ai[bot]`) | severity: critical/high/major/medium/moderate | severity: minor/low/nitpick/trivial/suggestion |
| **Copilot** (`copilot-pull-request-reviewer`) | `[critical]`, `[high]`, `[medium]`, or no tag | `[low]` or `[nitpick]` tags |
| **Human reviewers** | Always blocking | — |

- **Blocking reviews** (medium/high priority) → you MUST fix these
- **Non-blocking reviews** (low/nitpick) → shown as informational, do NOT block "PR READY TO REVIEW"

### 5.1 Read and Understand Feedback

For each **blocking** review comment:

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

### 5.4 Skip AI Comments That Conflict With User Intent

Sometimes AI reviewers (Cursor, Copilot) suggest reverting or undoing changes that the user explicitly requested. When you identify such comments:

1. **Do NOT implement the suggested change** — skip it entirely
2. **Fix all other legitimate review comments** normally (Steps 5.1–5.3)
3. **Report all skipped comments** to the user in the summary (see Step 6 templates) using this format:

```
### Skipped AI Review Comments (Conflict With User Intent)

I didn't address these comments:

**Comment 1:**
> {exact comment text}

**Why I disagree:**
{Detailed explanation of how exactly what the AI reviewer asked goes against
what the user requested. Be thorough — explain the conflict fully.}
Disagreed because of: {path to supporting document or quote of user instruction}
```

**Where to find evidence to support your disagreement:**
1. **Tasks folder** — Look in `${TASKS_BASE}/<TICKET_ID>/` for pre-planning docs, requirements, or design docs that justify the change
2. **User's direct instructions** — Quote what the user explicitly asked for in the conversation that triggered the work
3. **Ticket description** — Reference the Jira/Linear ticket requirements if they support the implementation

**Example:**
```
**Comment 1:**
> "Remove the error boundary wrapper, it adds unnecessary complexity"

**Why I disagree:**
Cursor is asking to remove the error boundary component that wraps the tips settings panel.
However, the user explicitly requested error boundaries to be added for resilience — this was
a deliberate architectural decision to prevent individual panel crashes from taking down the
entire settings page. Removing it would undo the core requirement of the task.
Disagreed because of: '${TASKS_BASE}/TICKET-123/tips-settings/pre-planning.md' — section "Error Handling"
specifies error boundaries as a requirement.
```

**How to identify conflicting comments:**
- The AI suggests removing/reverting code that implements a feature the user asked for
- The AI suggests a different approach that contradicts the user's explicit instructions or pre-planning docs
- The AI flags as "unnecessary" something that the user specifically requested

**When in doubt:** If you're unsure whether a comment conflicts with user intent, use AskUserQuestion to ask.

---

## Step 4: Diagnose and Fix Failures (ordered after Step 5 intentionally — reviews are triaged first)

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

### Skipped AI Review Comments (Conflict With User Intent)
<If any skipped comments, list each with comment text, why you disagree, and evidence>
<If none: omit this section>

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

### Skipped AI Review Comments (Conflict With User Intent)
<If any skipped comments, list each with comment text, why you disagree, and evidence>
<If none: omit this section>

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
1. Run `node scripts/follow-up-pr.js` → script waits for CI → exit 1 (CI failing: lint)
2. Diagnose: unused import in src/utils.ts
3. Fix: remove the unused import
4. Commit and push
5. Re-run script → script waits for CI → exit 1 (CI passes, but 2 blocking review comments [MEDIUM])
6. Address blocking review feedback, commit and push
7. Re-run script → script waits for CI → exit 0 → output shows "PR READY TO REVIEW"
8. Workflow complete — report success with all fixes and reviews addressed

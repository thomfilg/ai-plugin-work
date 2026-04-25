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

The `workflows/work/scripts/follow-up-pr.js` script handles all deterministic polling (CI checks, review fetching, bot review detection, state persistence). It loops internally, waiting 60s between attempts, so **YOU do not need to manage any loop or sleep**. The script exits only when there is something actionable or when all checks pass.

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
SCRIPT_PATH="$PLUGIN_ROOT/workflows/work/scripts/follow-up-pr.js"

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

The script persists state to `/tmp/.claude/follow-up-pr-<repo>-<PR_NUMBER>.json`. Read it for structured data:

```bash
cat /tmp/.claude/follow-up-pr-*-<PR_NUMBER>.json
```

The state file contains: `prNumber`, `prUrl`, `branch`, `startTime`, `attempts[]`, `finalStatus`, and `previousRunBotHashes` (hash strings from the last exit-fail run, replaced each run, cleared on success).

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

## Step 5: Address Review Feedback (Sequential Comment Resolution)

```
╔══════════════════════════════════════════════════════════════════════╗
║  CRITICAL: Process comments ONE AT A TIME using the sequential CLI  ║
║                                                                      ║
║  DO NOT try to read or fix all comments at once.                    ║
║  Get ONE comment → fix it → mark solved → get NEXT comment.        ║
╚══════════════════════════════════════════════════════════════════════╝
```

### 5.0 Snapshot PR Comments

First, detect the PR number and take a snapshot of all comments:

```bash
COMMENTS_SCRIPT="$PLUGIN_ROOT/workflows/work/scripts/follow-up-pr-comments.js"
PR_NUMBER=$(gh pr view --json number -q '.number')
node "$COMMENTS_SCRIPT" --snapshot --pr "$PR_NUMBER"
```

Then check how many blocking comments exist:

```bash
node "$COMMENTS_SCRIPT" --status
```

This shows a brief summary like: `Blocking: 8, Non-blocking: 5, Solved: 0, Skipped: 0`

### 5.1 Sequential Comment Loop

Process each blocking comment ONE AT A TIME:

```
WHILE there are unsolved blocking comments:
  1. Get the next unsolved comment:
     node "$COMMENTS_SCRIPT" --next-comment
     → Returns: comment ID, file, line, author, priority, body

  2. Read the referenced file at the indicated line
  3. Understand what the reviewer is asking for
  4. Fix the code (directly — no need for /work-implement for small fixes)
  5. Run tests to verify: node --test <affected-test-file>
  6. Mark the comment as solved:
     node "$COMMENTS_SCRIPT" --solve-comment <ID> $(git rev-parse HEAD) "<brief description of fix>"

  7. OR skip the comment if it conflicts with user intent:
     node "$COMMENTS_SCRIPT" --skip-comment <ID> "<reason why skipped>"

  REPEAT until --next-comment returns no more blocking comments
```

### 5.2 Commit and Push After All Comments

After ALL blocking comments are solved/skipped:

```bash
git add -A
# Use commit-writer agent
git push
```

### 5.3 Re-enter Monitor Loop

Return to Step 1 (re-run follow-up-pr.js) — the reviewer may post new comments after your push.

### 5.4 Skip AI Comments That Conflict With User Intent

When an AI reviewer suggests reverting or undoing changes the user explicitly requested:

1. **Do NOT implement** — skip it
2. Use: `node "$COMMENTS_SCRIPT" --skip-comment <ID> "Conflicts with user intent: <reason>"`
3. Report skipped comments in the summary

**Important notes:**
- **If a comment is ambiguous**, use AskUserQuestion to ask the user
- **Never dismiss or resolve review threads on GitHub** — let the reviewer verify
- **Process ONE comment at a time** — fix, verify, mark solved, then get next

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
3. **Ticket description** — Reference the ticket requirements from your configured provider if they support the implementation

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

1. Determine `<TICKET_ID>` from the current branch: `git branch --show-current | grep -oE '[A-Z]+-[0-9]+|GH-[0-9]+' || echo "unknown"`
2. Formulate a clear fix description including: what failed, root cause, file(s) to change
3. Invoke: `Skill(work-implement): --subtask <TICKET_ID> fix(ci): <fix description with file paths and context>`
4. After /work-implement completes, run: `Skill(check)`
5. Push: `git push`
6. Record the fix in summary.fixes array
7. Return to Step 1 (re-run monitor script)

If /work-implement fails, use AskUserQuestion to ask the user for guidance before retrying.

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

### Non-Blocking Comments Report

```
╔══════════════════════════════════════════════════════════════════════╗
║  MANDATORY: You MUST present this report to the user.               ║
║  Do NOT summarize. Enrich each comment with Reason as shown below. ║
╚══════════════════════════════════════════════════════════════════════╝
```

For each comment in the script's "Non-Blocking Comments Report", output:

**For NOT ADDRESSED comments:**
```
Comment N: <full comment text>
File: <file:line>
Author: @<author>
Status: NOT ADDRESSED
Reason: <Explain WHY this is not worth addressing. "Low priority" is not a reason.
        State the specific technical justification — e.g., "The duplicate listing
        only appears during the ready-to-review path which runs once per PR cycle,
        so the visual redundancy has no functional impact.">
```

**For DEDUPED comments:**
```
Comment N: <full comment text>
File: <file:line>
Author: @<author>
Status: DEDUPED — previously addressed, re-posted after force-push
Reason: Addressed in <file> <function/method> line <line>, commit <short_sha>.
        <Brief description of what was changed to address it.>
```

**For ACKNOWLEDGED comments (skipped per section 5.4 — conflicts with user intent):**
```
Comment N: <full comment text>
File: <file:line>
Author: @<author>
Status: ACKNOWLEDGED — intentionally skipped, conflicts with user intent
Reason: <Explain the conflict. Reference the specific requirement, ticket,
        or user instruction that this comment contradicts.
        E.g., "Copilot suggests removing the error boundary, but the user
        explicitly requested it in TICKET-123 acceptance criteria.">
```

To find "where addressed" for DEDUPED comments:
1. Read the comment's suggestion
2. Search the branch commits (`git log --oneline main..HEAD`) for the fix
3. Identify the file, function, line, and commit that addressed it

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

## Review Accountability

When the monitor script exits 0 (PR READY TO REVIEW) and the PR has review comments, it automatically generates a `review-accountability.json` artifact under `${TASKS_BASE}/<TICKET_ID>/`. This file records how each PR review comment was handled.

### Schema

JSON array where each entry contains:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number\|null` | GitHub comment ID |
| `author` | `string` | Comment author |
| `path` | `string\|null` | File path associated with the comment, or `null` when not tied to a specific file |
| `comment` | `string` | Comment body text (truncated to 120 chars) |
| `disposition` | `string` | One of: `addressed`, `acknowledged`, `outdated` |
| `reason` | `string` | Why this disposition was chosen |

### Dispositions

- **`addressed`** — Code was changed to fix the issue (blocking comments, deduplicated comments)
- **`acknowledged`** — Intentionally not addressed (non-blocking, low-priority, or conflicts with user intent)
- **`outdated`** — Comment refers to code that no longer exists

### Transition Gate

The `follow_up → ci` transition requires `review-accountability.json` to exist when the PR had review comments. If the file cannot be written (missing `TASKS_BASE` or ticket ID), a warning is logged to stderr but the script still exits 0.

---

## Example Invocation

User: `/follow-up-pr`

Claude will:
1. Run `node workflows/work/scripts/follow-up-pr.js` → script waits for CI → exit 1 (CI failing: lint)
2. Diagnose: unused import in src/utils.ts
3. Fix: remove the unused import
4. Commit and push
5. Re-run script → script waits for CI → exit 1 (CI passes, but 2 blocking review comments [MEDIUM])
6. Address blocking review feedback, commit and push
7. Re-run script → script waits for CI → exit 0 → output shows "PR READY TO REVIEW"
8. Workflow complete — report success with all fixes and reviews addressed

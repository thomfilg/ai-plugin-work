---
name: cleanup-worktrees
description: Safely clean up git worktrees by verifying code has been merged to main
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion, mcp__atlassian__jira_search, mcp__atlassian__jira_get_issue, mcp__atlassian__jira_get_transitions, mcp__atlassian__jira_transition_issue, mcp__linear__get_issue
---
# Cleanup Worktrees Command

Safely clean up git worktrees by thoroughly verifying code has been merged to main.

## Philosophy: Prefer False Negatives

**CRITICAL**: When in doubt, DO NOT DELETE. It's better to leave a worktree that could be deleted than to lose work.

## Instructions

### Step 1: Fetch latest main and list worktrees

```bash
cd ~/$REPO_NAME
git fetch origin main
git worktree list
```

### Step 2: For EACH worktree (except main), gather comprehensive data

#### 2.1 Basic git status
```bash
cd <worktree-path>
git status --porcelain
git branch --show-current
git log --oneline -5
```

#### 2.2 Check for uncommitted/unstaged changes
```bash
cd <worktree-path>
git status --porcelain
git stash list
```
- If ANY output → **DO NOT DELETE** - has uncommitted work

#### 2.3 Check for unpushed commits
```bash
cd <worktree-path>
git log origin/main..HEAD --oneline
```

#### 2.4 Check branch status
```bash
cd <worktree-path>
branch=$(git branch --show-current 2>/dev/null || echo "DETACHED")
echo "Branch: $branch"
```
- If "DETACHED" or empty → worktree may be in early stage, check further

### Step 3: Verify code is ACTUALLY merged (not just by name)

**This is critical** - Don't just check if a PR with the same name was merged. Verify the actual changes exist in main.

#### 3.1 For each significant file changed in the worktree
```bash
cd <worktree-path>
# Get files changed vs main
git diff --name-only origin/main...HEAD
```

#### 3.2 For each changed file, verify the changes exist in main
```bash
# Pick key functions/code blocks added in the worktree
# Search for them in main
cd ~/${REPO_NAME}
git log --oneline --all -S "<unique-code-snippet>" -- <file-path>
grep -r "<unique-identifier>" <relevant-paths>
```

#### 3.3 Check PR status with detailed info
```bash
cd <worktree-path>
branch=$(git branch --show-current)
if [ -n "$branch" ]; then
  gh pr list --head "$branch" --state all --json number,state,mergedAt,title,url
  # Also check if branch was merged via different PR name
  gh pr list --state merged --search "head:$branch" --json number,state,mergedAt,title
fi
```

### Step 4: Extract ticket task ID and check status

#### 4.1 Extract task ID from branch name or folder
```bash
# Branch names follow pattern: PROJ-XXX-description
# Folder names follow pattern: ${REPO_NAME}-PROJ-XXX
branch=$(git branch --show-current)
task_id=$(echo "$branch" | grep -oE '[A-Z]+-[0-9]+')
# Or from folder name
folder_name=$(basename "$(pwd)")
task_id=$(echo "$folder_name" | grep -oE '[A-Z]+-[0-9]+')
```

#### 4.2 Check ticket task status
Use the configured ticket provider's MCP tool (e.g., `mcp__atlassian__jira_get_issue` for Jira, `mcp__linear__get_issue` for Linear) with the task ID to check:
- **Backlog/To Do**: DO NOT DELETE - work hasn't started or is planned
- **In Progress**: DO NOT DELETE - actively being worked on
- **In Review/QA**: DO NOT DELETE - work may still need changes
- **Done/Closed**: Can consider deletion IF code verified in main

### Step 5: Handle worktrees with no branches (working stage)

If worktree has no branch or is in detached HEAD state:

#### 5.1 Check for any commits at all
```bash
cd <worktree-path>
git log --oneline | head -10
```

#### 5.2 Check last modification times of files
```bash
ls -la <worktree-path>
find <worktree-path> -type f -name "*.ts" -o -name "*.tsx" -mtime -7 | head -20
```
- Recently modified files suggest active work → DO NOT DELETE

#### 5.3 Check if folder has meaningful changes
```bash
cd <worktree-path>
git diff --stat HEAD~5..HEAD 2>/dev/null || git diff --stat
```

### Step 6: Build verification summary

Create a detailed table for each worktree:

| Worktree | Branch | Ticket Status | Uncommitted | Unpushed | PR Status | Code in Main | Safe |
|----------|--------|-------------|-------------|----------|-----------|--------------|------|
| path     | name   | status      | Yes/No      | Yes/No   | state     | Verified/No  | ?    |

### Step 7: Determine safety with conservative approach

**SAFE TO DELETE** (ALL must be true):
- ✅ No uncommitted changes (`git status --porcelain` empty)
- ✅ No stashes (`git stash list` empty)
- ✅ No unpushed commits OR PR is merged
- ✅ **Code verified to exist in main** (not just PR name match)
- ✅ Ticket task is Done/Closed (if task ID found)

**NOT SAFE / UNCERTAIN** (ANY of these = DO NOT DELETE):
- ❌ Has uncommitted changes
- ❌ Has stashes
- ❌ Has unpushed commits without merged PR
- ❌ PR is open or in review
- ❌ Ticket task is not Done/Closed
- ❌ Cannot verify code exists in main
- ❌ Detached HEAD with recent file modifications
- ❌ No branch and no clear PR history
- ⚠️ Any uncertainty whatsoever

### Step 8: Report to user BEFORE any deletion

Show clearly:

```
═══════════════════════════════════════════════════════════
                WORKTREE CLEANUP ANALYSIS
═══════════════════════════════════════════════════════════

SAFE TO DELETE (code verified in main):
─────────────────────────────────────────
1. /path/to/worktree-1
   Branch: feature-xyz
   Ticket: PROJ-123 (Done)
   PR: #456 (Merged on 2024-01-15)
   Verification: Key changes found in main at commit abc123

NOT SAFE (do not delete):
─────────────────────────────────────────
1. /path/to/worktree-2
   Branch: feature-abc
   Reason: Has 3 uncommitted files

2. /path/to/worktree-3
   Branch: (none - detached HEAD)
   Reason: Ticket PROJ-456 is "In Progress"

UNCERTAIN (keeping to be safe):
─────────────────────────────────────────
1. /path/to/worktree-4
   Branch: fix/something
   Reason: Could not verify code in main, keeping as precaution
```

### Step 9: Ask for explicit confirmation

```
Do you want to proceed with deleting the SAFE worktrees?
[List exact worktrees that will be deleted]

Type "yes" to confirm, or specify which ones to skip.
```

### Step 10: Only after confirmation, delete

```bash
cd ~/${REPO_NAME}

# For each confirmed worktree:
git worktree remove <path> --force
# Only delete branch if it exists and PR was merged
git branch -D <branch-name>
# Delete remote branch if exists
git push origin --delete <branch-name> 2>/dev/null || true
```

### Step 10.5: Transition ticket tasks to "In Testing" (for merged PRs)

For each deleted worktree where the **PR was merged**, transition the ticket task to "In Testing":

#### 10.5.1 Extract ticket task ID from branch name
```bash
# Branch names follow pattern: PROJ-XXX-description
task_id=$(echo "$branch_name" | grep -oE '[A-Z]+-[0-9]+')
```

#### 10.5.2 Check if task exists and get available transitions
Use the configured ticket provider's transition tool (e.g., `mcp__atlassian__jira_get_transitions` for Jira) with the task ID to get available transitions.

#### 10.5.3 Find "In Testing" transition
Look for a transition with name containing "In Testing", "Testing", or "QA".

#### 10.5.4 Transition the task
Use the configured ticket provider's transition tool (e.g., `mcp__atlassian__jira_transition_issue` for Jira) with:
- The ticket task ID (e.g., PROJ-123)
- `transition_id`: The ID of the "In Testing" transition
- `comment`: "Code merged to main and deployed. Ready for testing."

#### 10.5.5 Report transitions made
```
═══════════════════════════════════════════════════════════
                TICKET TASK TRANSITIONS
═══════════════════════════════════════════════════════════

TRANSITIONED TO "IN TESTING":
─────────────────────────────────────────
1. PROJ-123 - Feature description
   Previous status: In Review
   New status: In Testing
   PR: #456 (Merged)

SKIPPED (no transition needed):
─────────────────────────────────────────
1. PROJ-456 - Already in Testing/Done
2. PROJ-789 - No matching transition available

FAILED:
─────────────────────────────────────────
1. PROJ-999 - Transition not allowed from current status
```

**Rules for transitioning:**
- ✅ Only transition if PR was **merged** (not just closed)
- ✅ Transition if current status is "Backlog", "In Review", "Code Review", or similar
- ✅ Skip if already in "In Testing", "Done", or "Closed"
- ❌ Never transition if the worktree was kept (not deleted)

### Step 11: Final worktree cleanup

```bash
cd ~/${REPO_NAME}
git worktree prune
git remote prune origin
git worktree list  # Show final state
```

---

## Part 2: Remote Branch Cleanup

After cleaning up worktrees, also clean up stale remote branches.

### Step 12: List all remote branches

```bash
cd ~/${REPO_NAME}
git fetch --prune origin
git branch -r | grep -v HEAD | sort
```

### Step 13: Get PR status for all branches

```bash
gh pr list --state all --json headRefName,state,mergedAt,number,title --limit 200 | jq -r '.[] | "\(.headRefName)|\(.state)|\(.mergedAt // "null")|\(.number)|\(.title)"' | sort
```

### Step 14: Categorize remote branches

**SAFE TO DELETE (merged):**
- PR state is `MERGED`
- Code verified to exist in main (commit message visible in `git log origin/main`)

**SAFE TO DELETE (closed without merge):**
- PR state is `CLOSED` (not merged)
- Includes: test branches, backup branches, superseded branches

**NOT SAFE (keep):**
- PR is `OPEN` - active work
- Branch has no PR but matches an active worktree
- Protected branches: `main`, `qa`, `uat`, `prod`
- Dependabot branches (automated PRs)

**UNCERTAIN (keep to be safe):**
- Cannot determine PR status
- Closed PR but may contain useful unmerged code

### Step 15: Present remote branch analysis

Show clearly:

```
═══════════════════════════════════════════════════════════════════════════════
                     REMOTE BRANCH CLEANUP ANALYSIS
═══════════════════════════════════════════════════════════════════════════════

SAFE TO DELETE (PRs merged, code verified in main):
───────────────────────────────────────────────────────────────────────────────

1. origin/PROJ-123-feature-name
   PR: #456 (MERGED 2024-01-15) - "feat: add feature"

2. origin/fix/some-bug
   PR: #789 (MERGED 2024-01-10) - "fix: resolve bug"


CLOSED (no merge, safe to delete):
───────────────────────────────────────────────────────────────────────────────

1. origin/test-branch
   PR: #100 (CLOSED without merge)

2. origin/backup-PROJ-123
   No PR found - backup branch


NOT SAFE (active work or open PRs):
───────────────────────────────────────────────────────────────────────────────

1. origin/PROJ-456-active-work
   PR: #999 (OPEN) - active development

2. origin/dependabot/npm_and_yarn/package-1.0.0
   Open PR from Dependabot


UNCERTAIN (keeping to be safe):
───────────────────────────────────────────────────────────────────────────────

1. origin/old-feature-branch
   PR: #50 (CLOSED) - may have useful code


SUMMARY:
  - Safe to delete (merged): X branches
  - Safe to delete (closed): Y branches
  - NOT safe (active): Z branches
  - Uncertain (keeping): W branches
  - Protected: 4 branches (main, qa, uat, prod)

═══════════════════════════════════════════════════════════════════════════════
```

### Step 16: Ask for explicit confirmation

Use `AskUserQuestion` tool with options:
- "Yes, delete all X" - Delete all merged and closed branches
- "Only merged (Y)" - Delete only branches with merged PRs
- "No, keep all" - Don't delete any remote branches

### Step 17: Delete confirmed remote branches

Delete in batches of 10 to avoid timeouts:

```bash
cd ~/${REPO_NAME}
git push origin --delete branch1 branch2 branch3 branch4 branch5 branch6 branch7 branch8 branch9 branch10
```

**Important:**
- Use single-line format (no multiline with backslashes)
- Set timeout to 120000ms for remote operations
- Continue with next batch if any branch fails

### Step 18: Final remote cleanup

```bash
cd ~/${REPO_NAME}
git remote prune origin
echo "=== Remaining Remote Branches ===" && git branch -r | grep -v HEAD | wc -l && echo "branches remaining"
git branch -r | grep -v HEAD | sort
```

### Step 19: Show final summary

```
═══════════════════════════════════════════════════════════════════════════════
                        CLEANUP COMPLETE
═══════════════════════════════════════════════════════════════════════════════

WORKTREES DELETED: X
─────────────────────────────────────────
✅ worktree-1 (reason)
✅ worktree-2 (reason)


REMOTE BRANCHES DELETED: Y
─────────────────────────────────────────
• Z branches with merged PRs
• W branches with closed PRs / backups


REMAINING WORKTREES: A
─────────────────────────────────────────
1. main (primary worktree)
2. active-worktree (reason kept)


REMAINING REMOTE BRANCHES: B
─────────────────────────────────────────
• C active development branches
• D dependabot PRs (open)
• 4 protected branches (main, qa, uat, prod)
• E uncertain (kept for safety)


NOTE: If git stashes exist, run `git stash list` to review

═══════════════════════════════════════════════════════════════════════════════
```

---

## CRITICAL RULES

1. **NEVER delete without verifying code is in main** - PR name match is NOT enough
2. **NEVER delete worktrees with ticket tasks not in Done/Closed status**
3. **NEVER delete worktrees in detached HEAD with recent modifications**
4. **NEVER delete without explicit user confirmation**
5. **ALWAYS prefer false negatives** - keep uncertain worktrees
6. **ALWAYS show detailed reasoning** for each decision
7. **ALWAYS verify code existence** by checking actual file contents/functions in main

## Code Verification Examples

### Good verification:
```bash
# Worktree added a new function `calculateMetrics` in src/utils/metrics.ts
# Verify it exists in main:
cd ~/${REPO_NAME}
grep -r "calculateMetrics" src/utils/metrics.ts
# If found → code is in main
```

### Insufficient verification:
```bash
# Just checking PR was merged by title → NOT ENOUGH
gh pr list --state merged --search "PROJ-123"
# This doesn't prove the code is actually there!
```

## Edge Cases

### Worktree with work in progress (no commits yet)
- Check file modification times
- Check ticket task status
- Default: DO NOT DELETE

### Branch pushed but PR not created
- Code may be important work
- Default: DO NOT DELETE

### Old worktree with Done ticket but code not found in main
- May have been closed without merge
- Investigate before deleting
- Default: DO NOT DELETE (could be closed as won't-fix but has useful code)

### Multiple PRs from same branch
- Check ALL PRs, not just the latest
- Verify which one (if any) was actually merged

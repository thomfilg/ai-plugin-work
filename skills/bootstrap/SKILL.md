---
name: bootstrap
description: Setup multiple ticket tasks - creates worktrees, symlinks configs, and opens draft PRs
argument-hint: <task-ids...>
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, mcp__atlassian__jira_get_issue, mcp__linear__get_issue
---

# Setup multiple Jira tasks - creates worktrees, symlinks configs, and opens draft PRs

## Usage

```
/bootstrap <task-ids...>
```

**Examples:**
- `/bootstrap 123` - Bootstrap single task PROJ-123
- `/bootstrap 123 456 789` - Bootstrap multiple tasks
- `/bootstrap PROJ-123 PROJ-456` - Full task IDs also work

## Instructions

### Step 1: Parse task IDs

Extract task IDs from input. If only numbers provided, prefix with your Jira project key:

```bash
# Input: "123 456 789" or "PROJ-123 PROJ-456"
# Output: PROJ-123 PROJ-456 PROJ-789
```

### Step 2: For EACH task, execute the following steps

Loop through each task ID and perform Steps 3-9.

### Step 3: Fetch Jira ticket details

```
mcp__atlassian__jira_get_issue(issue_key: "PROJ-XXX")
```

Extract:
- Summary (for branch name)
- Description (for PR body)
- Status (verify it's not already Done)

### Step 4: Create branch and worktree

```bash
$REPO_NAME="look your current directory, then look if there are worktrees (folders in a directory above with same prefix). Eg: worktrees/my-repository-ticket-A, worktrees/my-repository-ticket-B, worktrees/my-repository << this is the main directory"

cd ~/${my_repository} # eg: cd ~/worktrees/my-repository
git fetch origin main

# Generate branch name from ticket
TICKET_ID="PROJ-XXX"
SHORT_DESC="short-description-kebab-case"  # Derived from summary
BRANCH_NAME="${TICKET_ID}-${SHORT_DESC}"
WORKTREE_PATH="../{$REPO_NAME}-${TICKET_ID}"

# Create worktree
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" origin/main
```

### Step 5: Setup worktree environment

```bash
cd "$WORKTREE_PATH"

# Copy credentials (required)
cp -r ../$REPO_NAME/credentials/* ./credentials/

# Symlink Claude config (required - keeps all worktrees in sync)
ln -s ../$REPO_NAME/.claude .claude

# Create CLAUDE.md symlink (required)
ln -s GEMINI.md CLAUDE.md

# Fix .env symlinks using the symlink helper script (uses absolute paths)
node ~/.claude/scripts/symlink.js --env

# Create .env.local for as-dashboard with title prefix (helps identify browser tabs)
cat > apps/as-dashboard/.env.local << EOF
# Local development overrides (gitignored)
# This file is for developer-specific settings

# Title prefix for browser tab (helps identify which browser belongs to which agent)
# Format: "{prefix} • AS Dashboard"
VITE_TITLE_PREFIX=${TICKET_ID}
EOF
```

### Step 6: Install dependencies

```bash
cd "$WORKTREE_PATH"
pnpm install
```

### Step 7: Create initial commit and push (if enabled)

```bash
cd "$WORKTREE_PATH"
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap-publish.js" --commit "$WORKTREE_PATH" "$BRANCH_NAME" "$TICKET_ID"
```

Skips entirely if `ENABLE_EMPTY_COMMIT` is not set.

### Step 8: Create draft PR

```bash
cd "$WORKTREE_PATH"
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap-publish.js" --pr "$WORKTREE_PATH" "$BRANCH_NAME" "$TICKET_ID"
```

Skips if `ENABLE_EMPTY_COMMIT` or `ENABLE_DRAFT_PR` is not set (no commit means no PR).

### Step 9: Report results

After processing all tasks, display summary:

```
═══════════════════════════════════════════════════════════
                 BOOTSTRAP COMPLETE
═══════════════════════════════════════════════════════════

Successfully bootstrapped 3 tasks:

┌─────────────────┬────────────────────────────────────────┬─────────┐
│ Task            │ Worktree                               │ PR      │
├─────────────────┼────────────────────────────────────────┼─────────┤
│ PROJ-123    │ ~/worktrees/$REPO_NAME-...-123       │ #401    │
│ PROJ-456    │ ~/worktrees/$REPO_NAME-...-456       │ #402    │
│ PROJ-789    │ ~/worktrees/$REPO_NAME-...-789       │ #403    │
└─────────────────┴────────────────────────────────────────┴─────────┘

Next steps:
1. cd ~/worktrees/$REPO_NAME-PROJ-123
2. Implement changes
3. Run /check when ready
4. Mark PR as ready for review
```

## Error Handling

### Task already has worktree
```
⚠️  PROJ-123: Worktree already exists at ~/worktrees/$REPO_NAME-PROJ-123
    Skipping...
```

### Task not found in Jira
```
❌ PROJ-999: Task not found in Jira
   Skipping...
```

### Branch already exists
```
⚠️  PROJ-123: Branch already exists
    Using existing branch...
```

## Quick Reference

| Step | Action |
|------|--------|
| 1 | Parse task IDs |
| 2 | Loop through tasks |
| 3 | Fetch Jira details |
| 4 | Create worktree + branch |
| 5 | Copy credentials, .claude, symlink CLAUDE.md, symlink .env files, create .env.local |
| 6 | pnpm install |
| 7 | Initial commit + push (empty commit if `ENABLE_EMPTY_COMMIT`) |
| 8 | Create draft PR (if `ENABLE_EMPTY_COMMIT` + `ENABLE_DRAFT_PR`) |
| 9 | Display summary |

## Notes

- Task IDs can be numbers only (123) or full IDs (PROJ-123)
- Default project key: configured via `JIRA_PROJECT_KEY` env var
- Worktree path: `../$REPO_NAME-<TICKET-ID>`
- Branch format: `<TICKET-ID>-<kebab-case-description>`
- Draft PRs created when both `ENABLE_EMPTY_COMMIT` and `ENABLE_DRAFT_PR` are set
- Empty bootstrap commits when `ENABLE_EMPTY_COMMIT` is set
- `.env.local` is created for `as-dashboard` with `VITE_TITLE_PREFIX` to identify browser tabs per agent

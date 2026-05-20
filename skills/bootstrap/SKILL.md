---
name: bootstrap
description: Setup multiple ticket tasks - creates worktrees and runs custom bootstrap scripts
argument-hint: <task-ids...>
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, mcp__atlassian__jira_get_issue, mcp__linear__get_issue
---

# Setup multiple ticket tasks - creates worktrees and runs custom bootstrap scripts

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

Extract task IDs from input. If only numbers provided, prefix with your project key:

```bash
# Input: "123 456 789" or "PROJ-123 PROJ-456"
# Output: PROJ-123 PROJ-456 PROJ-789
```

### Step 2: For EACH task, execute the following steps

Loop through each task ID and perform Steps 3-6.

### Step 3: Fetch ticket details

Fetch ticket details using the appropriate MCP tool for your configured ticket provider (see TICKET_PROVIDER config). For Jira: `mcp__atlassian__jira_get_issue`. For Linear: `mcp__linear__get_issue`. For GitHub: `gh issue view`.

Extract:
- Summary (for branch name)
- Description (for PR body)
- Status (verify it's not already Done)

### Step 4: Create branch and worktree

```bash
$REPO_NAME="look your current directory, then look if there are worktrees (folders in a directory above with same prefix). Eg: worktrees/my-repository-ticket-A, worktrees/my-repository-ticket-B, worktrees/my-repository << this is the main directory"

cd ~/${my_repository} # eg: cd ~/worktrees/my-repository
# Normalize BASE_BRANCH: strip "origin/" or "refs/remotes/origin/" prefix if present
BASE_BRANCH="${BASE_BRANCH:-main}"
BASE_BRANCH="${BASE_BRANCH#refs/remotes/origin/}"
BASE_BRANCH="${BASE_BRANCH#origin/}"
git fetch origin "$BASE_BRANCH"

# Generate branch name from ticket
TICKET_ID="PROJ-XXX"
SHORT_DESC="short-description-kebab-case"  # Derived from summary
BRANCH_NAME="${TICKET_ID}-${SHORT_DESC}"
WORKTREE_PATH="../{$REPO_NAME}-${TICKET_ID}"

# Create worktree
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "origin/$BASE_BRANCH"
```

### Step 5: Run custom bootstrap script (if configured)

```bash
cd "$WORKTREE_PATH"
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/scripts/bootstrap-custom-script.js" "$WORKTREE_PATH" "$TICKET_ID"
```

Runs the script specified by `BOOTSTRAP_SCRIPT` env var. The script receives the worktree path and ticket ID as arguments. If `BOOTSTRAP_SCRIPT` is not set, this step is skipped (logs "skipping" and exits 0). Script failures are non-fatal (warning only).

Configure in your `.envrc`:
```bash
export BOOTSTRAP_SCRIPT="./scripts/bootstrap.sh"
```

### Step 6: Report results

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

### Task not found in ticket provider
```
❌ PROJ-999: Task not found in ticket provider
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
| 3 | Fetch ticket details |
| 4 | Create worktree + branch (uses `BASE_BRANCH` env var, defaults to `main`) |
| 5 | Run custom bootstrap script (if `BOOTSTRAP_SCRIPT` is set) |
| 6 | Display summary |

**Note:** Bootstrap does NOT start the orchestrator listener. The
`<TICKET>-listen` tmux session is started by `/work2` on every
invocation (idempotent) so the worker — not the worktree creator —
owns the channel.

## Notes

- Task IDs can be numbers only (123) or full IDs (PROJ-123)
- Default project key: configured via `TICKET_PROJECT_KEY` env var (falls back to `JIRA_PROJECT_KEY`)
- Worktree path: `../$REPO_NAME-<TICKET-ID>`
- Branch format: `<TICKET-ID>-<kebab-case-description>`
- Custom bootstrap script: set `BOOTSTRAP_SCRIPT` env var to a script path (relative to repo root or absolute)
- The bootstrap script receives worktree path and ticket ID as arguments

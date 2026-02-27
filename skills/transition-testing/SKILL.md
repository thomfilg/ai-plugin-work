---
name: transition-testing
description: Transition Jira tasks from In Testing to Done after verifying PRs are merged
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob, AskUserQuestion, mcp__atlassian__jira_search, mcp__atlassian__jira_get_issue, mcp__atlassian__jira_get_transitions, mcp__atlassian__jira_transition_issue
---
# Transition Testing Tasks Command

Verifies if YOUR Jira tasks in "In Testing" status have PRs merged to main (deployed to production) and offers to transition them to Done.

## Philosophy: Confirm Before Acting

**CRITICAL**: Always show analysis first, then prompt for user confirmation before transitioning any tasks.

## Usage

```
/transition-testing
```

No arguments needed - automatically filters to your tasks only.

## Instructions

### Step 1: Get Current User Email

```bash
# Get user email from git config
git config user.email
```

Store as `userEmail` for filtering.

### Step 2: Search for YOUR Tasks in "In Testing" Status

```
mcp__atlassian__jira_search(
  jql: "project = ${JIRA_PROJECT_KEY} AND status = 'In Testing' AND assignee = currentUser() ORDER BY updated DESC",
  fields: "summary,status,assignee,updated,key",
  limit: 30
)
```

If no tasks found, report and exit:
```
✅ No tasks in "In Testing" status assigned to you.
   All your testing work appears to be either in progress or completed.
```

### Step 3: For EACH Task, Gather Comprehensive Data

#### 3.1 Search for merged PRs referencing the ticket
```bash
gh pr list --state merged --search "PROJ-XXX" --json number,title,mergedAt,url,mergeCommitSha --limit 5
```

#### 3.2 Verify merge commit exists in main
```bash
git fetch origin main
git log origin/main --oneline --grep="PROJ-XXX" | head -5
```

#### 3.3 Check for open PRs (work still in progress)
```bash
gh pr list --state open --search "PROJ-XXX" --json number,title,url
```

#### 3.4 Get PR details if found
```bash
# For each merged PR
gh pr view <PR_NUMBER> --json state,mergedAt,baseRefName,mergeCommitSha
```

### Step 4: Categorize Tasks

Group into three categories:

**READY TO TRANSITION** (ALL must be true):
- ✅ Has merged PR referencing ticket
- ✅ Merge commit verified in origin/main
- ✅ No open PRs for this ticket (all work complete)

**NOT READY** (ANY of these):
- ❌ Has open PR (work still in review)
- ❌ PR found but not merged
- ❌ Merge commit not found in main

**NEEDS MANUAL REVIEW**:
- ⚠️ No PR found at all
- ⚠️ Multiple PRs with mixed states
- ⚠️ Cannot determine status

### Step 5: Display Analysis Report

```
═══════════════════════════════════════════════════════════════════════════════
                    YOUR TASKS IN TESTING - ANALYSIS
═══════════════════════════════════════════════════════════════════════════════

Total tasks in "In Testing": X

✅ READY TO TRANSITION TO DONE (PR merged to main → deployed to prod):
───────────────────────────────────────────────────────────────────────────────
1. PROJ-123 - Add feature X
   PR: #401 (merged 2026-01-15)
   Merge commit: abc1234 in main

2. PROJ-124 - Fix bug Y
   PR: #403 (merged 2026-01-14)
   Merge commit: def5678 in main

❌ NOT READY (still in progress):
───────────────────────────────────────────────────────────────────────────────
1. PROJ-456 - Update Z
   PR: #402 (OPEN - still in review)
   Reason: PR not yet merged

⚠️ NEEDS MANUAL REVIEW:
───────────────────────────────────────────────────────────────────────────────
1. PROJ-789 - Refactor W
   Reason: No PR found referencing this ticket
   Action: Check if work was done under different PR or needs investigation
```

### Step 6: Prompt for Confirmation (if tasks ready)

If there are tasks ready to transition, use AskUserQuestion:

```
question: "Which tasks do you want to transition to Done?"
header: "Transition"
multiSelect: false
options:
  - label: "All ready tasks (X)"
    description: "Transition all X tasks that have merged PRs"
  - label: "Let me choose"
    description: "Show each task and let me exclude some"
  - label: "Skip for now"
    description: "Don't transition any tasks"
```

### Step 7: If "Let me choose", show selection

Use AskUserQuestion with multiSelect to let user exclude tasks:

```
question: "Select tasks to EXCLUDE from transition:"
header: "Exclude"
multiSelect: true
options:
  - label: "PROJ-123"
    description: "Add feature X (PR #401)"
  - label: "PROJ-124"
    description: "Fix bug Y (PR #403)"
```

### Step 8: Execute Transitions

For each confirmed task:

```
# Get available transitions
mcp__atlassian__jira_get_transitions(issue_key: "PROJ-XXX")

# Find "Done" transition (typically id: 41)
# Transition the issue
mcp__atlassian__jira_transition_issue(
  issue_key: "PROJ-XXX",
  transition_id: "41",
  comment: "PR #XXX merged to main (deployed to production)."
)
```

### Step 9: Final Summary

```
═══════════════════════════════════════════════════════════════════════════════
                         TRANSITION COMPLETE
═══════════════════════════════════════════════════════════════════════════════

✅ Transitioned to Done:
   • PROJ-123 - Add feature X
   • PROJ-124 - Fix bug Y

⏭️ Skipped (user excluded):
   • (none)

❌ Skipped (not ready):
   • PROJ-456 - PR still open

⚠️ Needs manual review:
   • PROJ-789 - No PR found
```

## Error Handling

### GitHub API Error
```
⚠️ GitHub API error while checking PRs for PROJ-XXX
   Error: <message>
   Marking as "needs review" - please check manually
```

### Jira Transition Failed
```
❌ Failed to transition PROJ-XXX
   Error: <message>
   Current status may not allow transition to Done
```

### No User Email Found
```
❌ Could not determine your email for filtering
   Please ensure git config user.email is set
```

## Safety Rules

1. **Only check YOUR tasks** - Filter by `assignee = currentUser()`
2. **Verify PR merged to main** - Merging to main triggers prod deployment
3. **Always prompt before transitioning** - Never auto-transition
4. **Allow exclusions** - User can skip specific tasks
5. **Report uncertainties** - Flag tasks needing manual review
6. **Add transition comment** - Document PR number and verification

## Quick Reference

| Category | Criteria | Action |
|----------|----------|--------|
| Ready | PR merged to main | Offer to transition |
| Not Ready | PR open or not merged | Skip, explain why |
| Needs Review | No PR or unclear | Flag for manual check |

ARGUMENTS: $ARGUMENTS

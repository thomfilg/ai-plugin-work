# /work-pr Workflow

PR description generation and visual documentation workflow.

## Invocation

```
/work-pr TICKET-123
```

Also invoked automatically as part of `/work2` at the `pr` step.

## Purpose

Generates a well-structured PR description from git diffs and adds visual documentation (screenshots, GIFs) to the PR.

## Agents

### pr-generator

**Role:** Generate PR title and description from git diffs.

**Actions:**
1. Check if branch is in sync with main, rebase if needed
2. Analyze code changes (entire branch diff or last commit)
3. Create PR via `gh pr create` with structured description:
   - Summary (1-3 bullet points)
   - Test plan (checklist)
   - Ticket reference

**Diff selection:**
- Last commit only → `git show HEAD`
- Entire branch → `git diff origin/main...HEAD`

### pr-post-generator

**Role:** Add visual documentation to PR.

**Actions:**
1. Read QA reports and screenshots from tasks folder
2. Upload images to wiki
3. Update PR description with wiki link

## State File

`TASKS_BASE/<ticket>/.work-pr.workflow-state.json`

## Agent-Executed Steps

The full `/work-pr` workflow also includes orchestration steps (preflight, setup, screenshot gating, summary). The two agent-executed steps are:

1. **pr-generator** — Create/update PR description
2. **pr-post-generator** — Add visual documentation (screenshots, recordings)

---
name: work
description: Orchestrated workflow for Jira tasks with deterministic step execution
argument-hint: <TICKET_ID or description> [--rework]
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite, Skill, mcp__atlassian__jira_get_issue, mcp__atlassian__jira_get_transitions, mcp__atlassian__jira_transition_issue
---

# /work - Orchestrated Workflow Command

Deterministic workflow that pre-computes an action plan and enforces exact step execution via state machine validation.

## Modes

| Mode | Command | Behavior |
|------|---------|----------|
| **Resume** (default) | `/work APPSUPEN-XXX` | Skip completed steps based on real state |
| **Rework** | `/work APPSUPEN-XXX --rework` | Re-run /check and PR update |

## How It Works

1. **Orchestrator generates plan** - Inspects git, files, reports, PRs
2. **You execute RUN steps** - Follow the plan exactly
3. **Validate transitions** - Call `transition` before each step
4. **Re-plan after fixes** - Fresh state inspection after any fix

---

## Step 1: FIRST TOOL CALL - Get the Plan

**MANDATORY: Your first action must be running the orchestrator.**

```bash
node ~/.claude/hooks/work-orchestrator.js "$ARGUMENTS"
```

Parse the JSON output. This is your roadmap.

### Understanding the Plan Output

```json
{
  "ticket": "APPSUPEN-881",
  "mode": "resume",
  "currentStep": "6_check",
  "allowedTransitions": ["7_cleanup", "8_test_enhancement", "3_implement"],
  "plan": [
    { "step": "1_ticket", "action": "SKIP", "reason": "Fetched" },
    { "step": "2_bootstrap", "action": "SKIP", "reason": "Worktree + PR #142 exist" },
    { "step": "3_implement", "action": "SKIP", "reason": "Changes exist: 4 files changed" },
    { "step": "6_check", "action": "RUN", "command": "/check", "reason": "missing: tests.check.md" }
  ],
  "summary": {
    "total": 14,
    "run": 4,
    "skip": 10,
    "firstAction": "6_check",
    "stepsToRun": ["6_check", "9_pr", "11_ci", "13_complete"]
  }
}
```

**Action Types:**
- `RUN` - Execute this step
- `SKIP` - Already done, move on
- `PENDING` - Depends on earlier steps

---

## Step 2: Execute RUN Steps in Order

For each step where `action = "RUN"`:

### 2a. Validate the Transition First

```bash
node ~/.claude/hooks/work-orchestrator.js transition APPSUPEN-XXX <target_step>
```

**If success:** Proceed with the step's command.

**If error:** The state machine blocked you. You must complete intermediate steps first. The error will tell you what steps are allowed:

```json
{
  "error": true,
  "message": "BLOCKED: 3_implement → 9_pr",
  "allowed": ["4_quality"],
  "hint": "From 3_implement you can go to: 4_quality"
}
```

### 2b. Execute the Step's Command

Run the command specified in the plan:

| Step | Typical Command |
|------|-----------------|
| 1_ticket | `mcp__atlassian__jira_get_issue` or `Task(jira-task-creator)` |
| 2_bootstrap | `/bootstrap TICKET` |
| 3_implement | `/work-implement <requirements>` |
| 4_quality | `pnpm dev:check` |
| 5_commit | `Task(commit-writer)` |
| 6_check | `/check` |
| 7_cleanup | `tmux kill-session -t TICKET-dev` |
| 8_test_enhancement | `Skill(test-coordination)` |
| 9_pr | `/work-pr TICKET` |
| 10_ready | `gh pr ready` |
| 11_ci | `gh pr checks --watch` |
| 12_reports | Consolidate reports |
| 13_complete | Mark state complete |

### 2c. Handle Failures

If a step fails:
1. Fix the issue
2. Re-run the orchestrator for a fresh plan
3. Continue from the new plan

---

## Step 3: Re-Plan After Fixes

After fixing any issue, always get a fresh plan:

```bash
node ~/.claude/hooks/work-orchestrator.js APPSUPEN-XXX
```

The orchestrator will re-inspect state and generate an updated plan.

---

## State Machine Transitions

```
Happy path:  1→2→3→4→5→6→7→8→9→10→11→12→13

Retry loops (backward):
  4_quality   → 3_implement   (quality failed)
  6_check     → 3_implement   (check found issues)
  8_test_enh  → 5_commit      (new tests need commit)
  11_ci       → 3_implement   (CI failed)
  11_ci       → 8_test_enh    (coverage failed)

Skip edges (forward):
  2_bootstrap → 4_quality     (code exists)
  2_bootstrap → 5_commit      (quality done)
  2_bootstrap → 6_check       (committed)
  6_check     → 8_test_enh    (no cleanup needed)
```

### Check Available Transitions

```bash
node ~/.claude/hooks/work-orchestrator.js transitions APPSUPEN-XXX
```

### View Full Graph

```bash
node ~/.claude/hooks/work-orchestrator.js graph
```

---

## Rules

1. **FIRST tool call = orchestrator** - No text-only responses before getting the plan
2. **Call transition before each RUN step** - Validates the move is legal
3. **Re-run orchestrator after any fix** - Fresh state inspection
4. **Never claim completion without plan showing all done** - The orchestrator is the source of truth
5. **Follow the plan exactly** - Don't skip steps, don't improvise

---

## Example Execution

```
User: /work APPSUPEN-881

Agent: [Runs orchestrator]
Plan shows:
  - 1_ticket: SKIP
  - 2_bootstrap: SKIP
  - 3_implement: SKIP
  - 4_quality: SKIP
  - 5_commit: SKIP
  - 6_check: RUN (missing reports)
  - 7_cleanup: SKIP
  - 8_test_enh: RUN
  - 9_pr: RUN
  - 10_ready: RUN
  - 11_ci: RUN
  - 12_reports: RUN
  - 13_complete: RUN

Agent: [Validates transition to 6_check]
Agent: [Runs /check]
Agent: [Check passes, validates transition to 8_test_enhancement]
Agent: [Runs test enhancement]
Agent: [Validates transition to 9_pr]
Agent: [Runs /work-pr]
... continues until 13_complete
```

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `work-orchestrator.js TICKET` | Generate action plan |
| `work-orchestrator.js TICKET --rework` | Force re-run checks |
| `work-orchestrator.js transition TICKET STEP` | Validate & record step change |
| `work-orchestrator.js transitions TICKET` | Show allowed next steps |
| `work-orchestrator.js graph` | Show full state machine |

---

## Troubleshooting

### "BLOCKED" error on transition
You're trying to skip steps. Complete the intermediate steps first, or check if there's a valid skip edge.

### Plan shows unexpected state
The orchestrator reads real files/git state. If something looks wrong:
1. Check the `state` object in the plan output
2. Verify files exist where expected
3. Run `git status` to confirm git state

### Steps keep showing RUN after completion
The orchestrator uses file presence and content to detect completion. Ensure:
- Reports have correct `Status: APPROVED` patterns
- Commits include the ticket ID
- Files are in expected locations

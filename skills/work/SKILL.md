---
name: work
description: Orchestrated workflow for Jira tasks with deterministic step execution
argument-hint: <TICKET_ID or description> [--rework]
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite, Skill, mcp__atlassian__jira_get_issue, mcp__atlassian__jira_get_transitions, mcp__atlassian__jira_transition_issue
---

# /work - Pure Orchestrator Workflow

You are a **pure orchestrator**. You NEVER execute step work directly — you ALWAYS delegate to sub-agents via `Task()` or `Skill()`. The only commands you run inline are:
- The orchestrator itself (plan/transition)
- Tiny metadata commands (reading plan JSON, writing state)

This keeps your context window lean: just plan JSON + transition outputs + agent summaries.

## Modes

| Mode | Command | Behavior |
|------|---------|----------|
| **Resume** (default) | `/work PROJ-XXX` | Skip completed steps based on real state |
| **Rework** | `/work PROJ-XXX --rework` | Re-run /check and PR update |

---

## Step 1: FIRST TOOL CALL - Get the Plan

**MANDATORY: Your first action must be running the orchestrator.**

```bash
node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js "$ARGUMENTS"
```

Parse the JSON output. This is your roadmap. Each RUN step includes `agentType` and `agentPrompt` — use these directly.

### Understanding the Plan Output

```json
{
  "ticket": "PROJ-881",
  "mode": "resume",
  "currentStep": "6_check",
  "plan": [
    { "step": "1_ticket", "action": "SKIP", "reason": "Fetched" },
    { "step": "4_quality", "action": "RUN", "command": "Task(quality-checker)",
      "agentType": "quality-checker",
      "agentPrompt": "Run quality checks in /home/node/worktrees/...\npnpm dev:check\n\nReturn PASS or FAIL with summary.",
      "reason": "Lint + typecheck + test" }
  ],
  "summary": { "total": 14, "run": 4, "skip": 10, "firstAction": "6_check" }
}
```

**Action Types:**
- `RUN` - Delegate this step to a sub-agent
- `SKIP` - Already done, move on
- `PENDING` - Depends on earlier steps

---

## Step 2: Execute RUN Steps in Order

For each step where `action = "RUN"`:

### 2a. Validate the Transition First

```bash
node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js transition PROJ-XXX <target_step>
```

**If success:** Proceed with delegation.
**If error:** Complete intermediate steps first.

### 2b. Delegate the Step

Use the plan's `agentType` and `agentPrompt` to delegate. **NEVER run step commands yourself.**

**Delegation by agentType:**

| agentType | How to Delegate | Description Field Convention |
|-----------|----------------|------------------------------|
| `general-purpose` | `Task(general-purpose)` | `"<step_name> <short description>"` |
| `jira-task-creator` | `Task(jira-task-creator)` | `"1_ticket create ticket"` |
| `quality-checker` | `Task(quality-checker)` | `"4_quality run checks"` |
| `commit-writer` | `Task(commit-writer)` | `"5_commit changes"` |
| `Bash` | `Task(Bash)` | `"<step_name> <short description>"` |
| `skill` | `Skill(<skill_name>)` | N/A (use Skill tool directly) |

**CRITICAL**: For Task-based delegations, the `description` field MUST start with the step name (e.g., `"7_cleanup kill dev session"`). This is how the enforcement hook identifies which step the Task belongs to.

#### Delegation Examples

**Task-based step (e.g., 4_quality):**
```
Task(quality-checker):
  description: "4_quality run checks"
  prompt: <agentPrompt from plan>
```

**Task-based Bash step (e.g., 10_ready):**
```
Task(Bash):
  description: "10_ready mark PR ready"
  prompt: <agentPrompt from plan>
```

**Skill-based step (e.g., 6_check):**
```
Skill(check)
```

**General-purpose step (e.g., 1_ticket fetch):**
```
Task(general-purpose):
  description: "1_ticket fetch ticket details"
  prompt: <agentPrompt from plan>
```

### 2c. Check Agent Result

After each agent returns:
- **Success**: Move to next RUN step
- **Failure**: Re-plan (Step 3)

### 2d. Pre-Commands (if present)

Some steps include `preCommands` (e.g., rework mode for 6_check). Run these via `Task(Bash)` before the main delegation:
```
Task(Bash):
  description: "6_check pre-cleanup"
  prompt: "Run these commands:\n<preCommands from plan>"
```

---

## Step 3: Re-Plan After Failures

If a step fails:
1. Do NOT reason about the failure in your context — the agent's summary is sufficient
2. Re-run the orchestrator for a fresh plan:
```bash
node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js PROJ-XXX
```
3. Continue from the new plan

---

## Step-by-Step Delegation Reference

| Step | agentType | Delegation |
|------|-----------|------------|
| `1_ticket` (fetch) | `general-purpose` | `Task(general-purpose)` — fetches Jira ticket via MCP |
| `1_ticket` (create) | `jira-task-creator` | `Task(jira-task-creator)` — creates new ticket |
| `2_bootstrap` | `skill` | `Skill(bootstrap)` |
| `2b_transition` | `general-purpose` | `Task(general-purpose)` — transitions Jira status |
| `3_implement` | `skill` | `Skill(work-implement)` |
| `4_quality` | `quality-checker` | `Task(quality-checker)` — runs pnpm dev:check |
| `5_commit` | `commit-writer` | `Task(commit-writer)` |
| `6_check` | `skill` | `Skill(check)` |
| `7_cleanup` | `Bash` | `Task(Bash)` — kills tmux dev session |
| `8_test_enhancement` | `skill` | `Skill(test-coordination)` |
| `9_pr` | `skill` | `Skill(work-pr)` |
| `10_ready` | `Bash` | `Task(Bash)` — runs `gh pr ready` |
| `11_ci` | `Bash` | `Task(Bash)` — watches CI with `gh pr checks` |
| `12_reports` | `Bash` | `Task(Bash)` — consolidates reports |
| `13_complete` | `Bash` | `Task(Bash)` — marks workflow complete |

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

---

## Rules

1. **FIRST tool call = orchestrator** — No text-only responses before getting the plan
2. **Call transition before each RUN step** — Validates the move is legal
3. **NEVER run step commands directly** — Always delegate via Task() or Skill()
4. **Task description MUST start with step name** — e.g., `"7_cleanup kill dev session"`
5. **Re-run orchestrator after any failure** — Fresh state inspection
6. **Never claim completion without plan showing all done** — The orchestrator is truth
7. **Only run inline**: orchestrator commands, transitions, and reading plan output
8. **Don't process large outputs** — Agent summaries are enough for decision-making

---

## Example Execution

```
User: /work PROJ-881

Agent: [Runs orchestrator — gets plan JSON]
Plan shows:
  - 1_ticket: SKIP
  - 6_check: RUN (agentType: "skill", agentPrompt: "/check")
  - 10_ready: RUN (agentType: "Bash", agentPrompt: "gh pr ready")

Agent: [Transition to 6_check]
Agent: [Skill(check)]  ← delegated, not inline
Agent: [Transition to 10_ready]
Agent: [Task(Bash) description="10_ready mark PR ready"]  ← delegated
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

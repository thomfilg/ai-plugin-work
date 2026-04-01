---
name: work
description: Orchestrated workflow for ticket tasks with deterministic step execution
argument-hint: <TICKET_ID or description> [--rework]
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, TodoWrite, Skill, mcp__atlassian__jira_get_issue, mcp__atlassian__jira_get_transitions, mcp__atlassian__jira_transition_issue, mcp__linear__get_issue, mcp__linear__save_issue
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

## TDD Execution Policy

When `WORK_TDD_ENFORCE=1` is set, `/work` enforces TDD for all implementation work entering `implement`.

Delegated agents must follow this loop:

1. Identify the smallest behavior change to prove
2. Find the nearest existing test file or create one
3. Write the smallest focused failing test set first (usually 1-3 tests)
4. Run the smallest relevant test command and confirm RED
5. Implement the minimum production change needed
6. Re-run the same tests and confirm GREEN
7. Refactor only after GREEN
8. Record TDD evidence via `work-orchestrator.js record-tdd` CLI
9. Run broader quality checks after targeted tests pass

Enforcement: The orchestrator blocks transitions out of `implement`
unless a valid TDD evidence file exists. This is a hard gate, not a suggestion.

Toggle: TDD enforcement is controlled by `WORK_TDD_ENFORCE=1` in `.envrc`. When unset
or `0`, the workflow runs without TDD gates — useful during initial rollout or for
projects that haven't adopted TDD yet.

Allowed exception: For mechanical refactors, file moves, or non-testable config-only changes,
the agent must set `exceptionReason` in the evidence file explaining why literal RED-first
was not appropriate.

Why only this step: Other steps in the workflow don't produce new application code —
they commit, verify, generate PRs, or package work that was already validated by the TDD-gated
`implement` step.

---

## Step 1: FIRST TOOL CALL - Get the Plan

**MANDATORY: Your first action must be running the orchestrator.**

```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work/work.workflow.js "$ARGUMENTS"
```

Parse the JSON output. This is your roadmap. Each RUN step includes `agentType` and `agentPrompt` — use these directly.

### Understanding the Plan Output

```json
{
  "ticket": "PROJ-881",
  "mode": "resume",
  "currentStep": "check",
  "plan": [
    { "step": "ticket", "action": "SKIP", "reason": "Fetched" },
    { "step": "check", "action": "RUN", "command": "/check",
      "agentType": "skill",
      "agentPrompt": "/check",
      "reason": "Quality checks + code review" }
  ],
  "summary": { "total": 14, "run": 4, "skip": 10, "firstAction": "check" }
}
```

**Action Types:**
- `RUN` - Delegate this step to a sub-agent
- `SKIP` - Already done, move on
- `DEFER` - Re-evaluate when you reach this step (state may change during workflow). Re-run the orchestrator plan command to get the current action before executing.
- `PENDING` - Depends on earlier steps

---

## Step 2: Execute RUN and DEFER Steps in Order

For each step where `action = "RUN"` or `action = "DEFER"`:

**DEFER steps:** Before executing, re-run the orchestrator plan with the same flags used originally (e.g. include `--rework` if the workflow was started with it):
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work/work.workflow.js <TICKET_ID> [--rework]
```
Check the step's action in the **new** plan:
- If now `RUN` → proceed with delegation using the **new plan's** agentType/agentPrompt
- If now `SKIP` → skip the step and transition to the next one
- If still `DEFER` → execute using the DEFER step's agentType/agentPrompt (included as fallback metadata)

For each `RUN` step (or DEFER resolved to RUN):

### 2a. Validate the Transition First

```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work/work.workflow.js transition PROJ-XXX <target_step>
```

**If success:** Proceed with delegation.
**If error:** Complete intermediate steps first.

### 2b. Delegate the Step

Use the plan's `agentType` and `agentPrompt` to delegate. **NEVER run step commands yourself.**

**Delegation by agentType:**

| agentType | How to Delegate | Description Field Convention |
|-----------|----------------|------------------------------|
| `general-purpose` | `Task(general-purpose)` | `"<step_name> <short description>"` |
| `jira-task-creator` | `Task(jira-task-creator)` | `"ticket create ticket"` |
| `skill` | `Skill(<skill_name>)` | N/A (agentPrompt is usually a literal command like `/check` or `/bootstrap`) |
| `commit-writer` | `Task(commit-writer)` | `"commit changes"` |
| `Bash` | `Task(Bash)` | `"<step_name> <short description>"` |

**CRITICAL**: For Task-based delegations, the `description` field MUST start with the step name (e.g., `"cleanup kill dev session"`). This is how the enforcement hook identifies which step the Task belongs to.

#### Delegation Examples

**Task-based Bash step (e.g., ready):**
```
Task(Bash):
  description: "ready mark PR ready"
  prompt: <agentPrompt from plan>
```

**Skill-based step (e.g., check):**
```
Skill(check)
```

**General-purpose step (e.g., ticket fetch):**
```
Task(general-purpose):
  description: "ticket fetch ticket details"
  prompt: <agentPrompt from plan>
```

### TDD augmentation for implementation steps

For `implement`, the orchestrator automatically appends TDD protocol
instructions to the `agentPrompt`. The delegated agent must:
- Write focused failing tests before implementation when the change is behavior-testable
- Run the smallest relevant test command first and confirm failure
- Implement the minimum fix
- Re-run the same test command and confirm pass
- Record evidence via `work-orchestrator.js record-tdd` CLI before completing
- Refactor only after the targeted tests pass

### 2c. Check Agent Result

After each agent returns:
- **Success**: Move to next RUN step
- **Failure**: Re-plan (Step 3)

### 2d. Pre-Commands (if present)

Some steps include `preCommands` (e.g., rework mode for check). Run these via `Task(Bash)` before the main delegation:
```
Task(Bash):
  description: "check pre-cleanup"
  prompt: "Run these commands:\n<preCommands from plan>"
```

---

## Step 3: Re-Plan After Failures

If a step fails:
1. Do NOT reason about the failure in your context — the agent's summary is sufficient
2. Re-run the orchestrator for a fresh plan:
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/work/work.workflow.js PROJ-XXX
```
3. Continue from the new plan

---

## Step-by-Step Delegation Reference

| Step | agentType | Delegation |
|------|-----------|------------|
| `ticket` (fetch) | `general-purpose` | `Task(general-purpose)` — fetches Jira ticket via MCP |
| `ticket` (create) | `jira-task-creator` | `Task(jira-task-creator)` — creates new ticket |
| `bootstrap` | `skill` | `Skill(bootstrap)` |
| `2b_transition` | `general-purpose` | `Task(general-purpose)` — transitions Jira status |
| `brief` | `brief-writer` | `Task(brief-writer)` — generates product brief from ticket requirements |
| `spec` | `spec-writer` | `Task(spec-writer)` — generates technical spec with test scenarios from brief + codebase |
| `implement` | `skill` | `Skill(work-implement)` |
| `commit` | `commit-writer` | `Task(commit-writer)` |
| `check` | `skill` | `Skill(check)` |
| `cleanup` | `Bash` | `Task(Bash)` — kills tmux dev session |
| `pr` | `skill` | `Skill(work-pr)` |
| `ready` | `Bash` | `Task(Bash)` — runs `gh pr ready` |
| `ci` | `Bash` | `Task(Bash)` — watches CI with `gh pr checks` |
| `reports` | `Bash` | `Task(Bash)` — consolidates reports |
| `complete` | `Bash` | `Task(Bash)` — marks workflow complete |

---

## State Machine Transitions

```
Happy path:  ticket→bootstrap→brief→spec→implement→commit→check→pr→ready→follow_up→ci→cleanup→reports→complete

Retry loops (backward):
  check     → implement   (check found issues)
  follow_up → implement   (follow-up requires code changes)
  ci        → implement   (CI failed)

Skip edges (forward):
  bootstrap → spec        (brief disabled, skip to spec)
  bootstrap → implement   (brief/spec disabled or done)
  bootstrap → commit      (resume: code already done)
  bootstrap → check       (resume: committed, need check)
  brief     → implement   (spec disabled, skip to implement)
  check     → pr          (check passed, go to PR)
  pr        → ci          (PR already ready, skip ready)
  ready     → ci          (follow_up skipped)
  follow_up → ci          (skip to CI)
  follow_up → cleanup     (skip CI)
```

---

## Rules

1. **FIRST tool call = orchestrator** — No text-only responses before getting the plan
2. **Call transition before each RUN step** — Validates the move is legal
3. **NEVER run step commands directly** — Always delegate via Task() or Skill()
4. **Task description MUST start with step name** — e.g., `"cleanup kill dev session"`
5. **Re-run orchestrator after any failure** — Fresh state inspection
6. **Never claim completion without plan showing all done** — The orchestrator is truth
7. **Only run inline**: orchestrator commands, transitions, and reading plan output
8. **Don't process large outputs** — Agent summaries are enough for decision-making
9. `implement` enforces TDD — transitions out are blocked without
   recorded TDD evidence proving GREEN or providing an explicit exception reason

---

## Example Execution

```
User: /work PROJ-881

Agent: [Runs orchestrator — gets plan JSON]
Plan shows:
  - ticket: SKIP
  - check: RUN (agentType: "skill", agentPrompt: "/check")
  - ready: RUN (agentType: "Bash", agentPrompt: "gh pr ready")

Agent: [Transition to check]
Agent: [Skill(check)]  ← delegated, not inline
Agent: [Transition to ready]
Agent: [Task(Bash) description="ready mark PR ready"]  ← delegated
... continues until complete
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
| `work-orchestrator.js record-tdd TICKET STEP [flags]` | Record TDD evidence (atomic write) |

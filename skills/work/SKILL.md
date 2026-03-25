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

When `WORK_TDD_ENFORCE=1` is set, `/work` enforces TDD for all implementation work entering `implement` or `test_enhancement`.

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

Enforcement: The orchestrator blocks transitions out of `implement` and `test_enhancement`
unless a valid TDD evidence file exists. This is a hard gate, not a suggestion.

Toggle: TDD enforcement is controlled by `WORK_TDD_ENFORCE=1` in `.envrc`. When unset
or `0`, the workflow runs without TDD gates — useful during initial rollout or for
projects that haven't adopted TDD yet.

Allowed exception: For mechanical refactors, file moves, or non-testable config-only changes,
the agent must set `exceptionReason` in the evidence file explaining why literal RED-first
was not appropriate.

Why only these two steps: Other steps in the workflow don't produce new application code —
they commit, verify, generate PRs, or package work that was already validated by TDD-gated
steps. Gating `implement` and `test_enhancement` covers all code-producing transitions.

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
  "currentStep": "check",
  "plan": [
    { "step": "ticket", "action": "SKIP", "reason": "Fetched" },
    { "step": "quality", "action": "RUN", "command": "Task(quality-checker)",
      "agentType": "quality-checker",
      "agentPrompt": "Run quality checks in /home/node/worktrees/...\nUse pnpm dev:check if available, bundled dev-check scripts as fallback, or pnpm lint && pnpm typecheck && pnpm test as last resort.\n\nReturn PASS or FAIL with summary.",
      "reason": "Lint + typecheck + test" }
  ],
  "summary": { "total": 16, "run": 4, "skip": 12, "firstAction": "check" }
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
| `jira-task-creator` | `Task(jira-task-creator)` | `"ticket create ticket"` |
| `quality-checker` | `Task(quality-checker)` | `"quality run checks"` |
| `commit-writer` | `Task(commit-writer)` | `"commit changes"` |
| `Bash` | `Task(Bash)` | `"<step_name> <short description>"` |
| `skill` | `Skill(<skill_name>)` | N/A (use Skill tool directly) |

**CRITICAL**: For Task-based delegations, the `description` field MUST start with the step name (e.g., `"cleanup kill dev session"`). This is how the enforcement hook identifies which step the Task belongs to.

#### Delegation Examples

**Task-based step (e.g., quality):**
```
Task(quality-checker):
  description: "quality run checks"
  prompt: <agentPrompt from plan>
```

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

For `implement` and `test_enhancement`, the orchestrator automatically appends TDD protocol
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
node ${CLAUDE_PLUGIN_ROOT}/hooks/work-orchestrator.js PROJ-XXX
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
| `quality` | `quality-checker` | `Task(quality-checker)` — runs quality checks (dev:check → bundled scripts → lint/typecheck/test) |
| `commit` | `commit-writer` | `Task(commit-writer)` |
| `check` | `skill` | `Skill(check)` |
| `cleanup` | `Bash` | `Task(Bash)` — kills tmux dev session |
| `test_enhancement` | `skill` | `Skill(test-coordination)` |
| `pr` | `skill` | `Skill(work-pr)` |
| `ready` | `Bash` | `Task(Bash)` — runs `gh pr ready` |
| `ci` | `Bash` | `Task(Bash)` — watches CI with `gh pr checks` |
| `reports` | `Bash` | `Task(Bash)` — consolidates reports |
| `complete` | `Bash` | `Task(Bash)` — marks workflow complete |

---

## State Machine Transitions

```
Happy path:  ticket→bootstrap→brief→spec→implement→quality→commit→check→test_enhancement→pr→ready→ci→cleanup→reports→complete

Retry loops (backward):
  quality   → implement   (quality failed)
  commit    → quality     (re-verify after commit)
  check     → implement   (check found issues)
  check     → quality     (check needs quality re-run)
  test_enh  → commit      (new tests need commit)
  test_enh  → quality     (new tests need quality check)
  test_enh  → implement   (tests reveal implementation flaw)
  ci       → implement   (CI failed)
  ci       → test_enh    (coverage failed)

Skip edges (forward):
  bootstrap → implement   (brief/spec disabled or done)
  bootstrap → quality     (code exists)
  bootstrap → commit      (quality done)
  bootstrap → check       (committed)
  brief     → implement   (spec disabled, skip to implement)
  check     → test_enh    (no cleanup needed)
  pr        → ci         (PR already ready, skip ready)
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
9. `implement` and `test_enhancement` enforce TDD — transitions out are blocked without
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

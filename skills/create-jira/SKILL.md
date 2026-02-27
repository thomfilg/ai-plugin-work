---
name: create-jira
description: Orchestrated Jira task creation with deterministic step execution via workflow engine
argument-hint: <task description>
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion, mcp__atlassian__jira_create_issue, mcp__atlassian__jira_search, mcp__atlassian__jira_get_issue
---
# /create-jira - Orchestrated Jira Task Creation

Deterministic workflow that pre-computes an action plan and enforces exact step execution via the reusable workflow engine.

Orchestrates multiple specialized agents to collaboratively design and create well-thought-out Jira tasks.

## Related Documents

| Document | Contents |
|----------|----------|
| [create-jira-agents.md](create-jira-agents.md) | Agent consultation prompts |
| [create-jira-consensus.md](create-jira-consensus.md) | Consensus protocol & error handling |
| [create-jira-design-doc.md](create-jira-design-doc.md) | Design doc evaluation |
| [create-jira-wiki.md](create-jira-wiki.md) | Wiki publishing |

## Usage

```
/create-jira <task description>
```

**Examples:**
- `/create-jira add integration tests for status-site-worker that run the entire code but mock external requests`
- `/create-jira create a new dashboard component showing real-time metrics`

---

## Step 1: FIRST TOOL CALL - Get the Plan

**MANDATORY: Your first action must be running the workflow engine.**

```bash
node lib/workflow-engine.js create-jira plan "$ARGUMENTS"
```

Parse the JSON output. This is your roadmap.

### Understanding the Plan Output

```json
{
  "workflow": "create-jira",
  "command": "/create-jira",
  "instanceId": "add-integration-tests-for",
  "params": {
    "slug": "add-integration-tests-for",
    "description": "add integration tests for status-site-worker..."
  },
  "plan": [
    { "step": "1_parse", "action": "RUN", "reason": "Parse and analyze the request" },
    { "step": "2_drafts", "action": "SKIP", "reason": "Draft dir exists" },
    { "step": "4_context", "action": "RUN", "command": "Task(Explore)", "reason": "Gather codebase context" },
    ...
  ],
  "summary": {
    "total": 11,
    "run": 7,
    "skip": 4,
    "firstAction": "1_parse",
    "stepsToRun": ["1_parse", "4_context", "5_consult", "6_consensus", ...]
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
node lib/workflow-engine.js create-jira transition <slug> <target_step>
```

**If success:** Proceed with the step's command.

**If error (BLOCKED):** Complete intermediate steps first. The error tells you what steps are allowed.

### 2b. Execute the Step's Command

| Step | What to do |
|------|-----------|
| 1_parse | Parse the description. Extract: what's being built, which apps, task type |
| 2_drafts | `mkdir -p tasks/drafts/${slug}` |
| 3_agents | Determine agents using keyword detection (see create-jira-agents.md Step 3) |
| 4_context | `Task(Explore)` scoped to relevant app. Save to `tasks/drafts/${slug}/context.md` |
| 5_consult | Run agents IN PARALLEL (iteration 1) or SEQUENTIALLY (iteration 2+). See [create-jira-agents.md](create-jira-agents.md) |
| 6_consensus | Check consensus. See [create-jira-consensus.md](create-jira-consensus.md). If no consensus → transition back to 5_consult |
| 7_design_doc | Evaluate complexity triggers. See [create-jira-design-doc.md](create-jira-design-doc.md). Offer design doc if 2+ triggers |
| 8_confirm | Show task summary via AskUserQuestion. Options: Create / Review / Modify / Skip wiki |
| 9_wiki | Publish design doc to wiki. See [create-jira-wiki.md](create-jira-wiki.md). Only if design doc exists |
| 10_create | `Task(jira-task-creator)` with final-task.md content |
| 11_report | Show completion report with ticket URL, agents involved, design doc links |
| 12_bootstrap | Ask user Yes/No if they want to `/bootstrap` the created ticket. If Yes, run `Skill("bootstrap", args: "<ticket-number>")` |

### 2c. Handle Failures

If a step fails:
1. Fix the issue
2. Re-run the workflow engine for a fresh plan:
   ```bash
   node lib/workflow-engine.js create-jira plan "<description>"
   ```
3. Continue from the new plan

### 2d. Consensus Loop

If consensus is NOT reached at step 6_consensus:
1. Transition back to 5_consult: `node lib/workflow-engine.js create-jira transition <slug> 5_consult`
2. Re-run agents SEQUENTIALLY (agents review each other's changes)
3. Maximum 3 iterations, then escalate to user

### 2e. User Rejection Loop

If user selects "Modify" at step 8_confirm:
1. Transition back to 5_consult: `node lib/workflow-engine.js create-jira transition <slug> 5_consult`
2. Incorporate user feedback into next agent consultation round

### 2f. Bootstrap Prompt (Step 12)

After the completion report, ask the user if they want to bootstrap the created ticket:

```
AskUserQuestion with:
  question: "Do you want to bootstrap a worktree for <TICKET-KEY>?"
  header: "Bootstrap"
  options:
    - label: "Yes"
      description: "Create worktree, install deps, push branch, and open draft PR"
    - label: "No"
      description: "Skip — I'll set it up later"
```

**If user selects "Yes":** Run `Skill("bootstrap", args: "<ticket-key>")` with the full ticket key (e.g., `PROJ-959`).

**If user selects "No":** Skip and end the workflow.

---

## Step 3: Re-Plan After Fixes

After fixing any issue, always get a fresh plan:

```bash
node lib/workflow-engine.js create-jira plan "<description>"
```

---

## State Machine Transitions

```
Happy path:  1→2→3→4→5→6→7→8→9→10→11→12

Retry loops (backward):
  6_consensus → 5_consult     (no consensus, re-consult)
  8_confirm   → 5_consult     (user wants changes)

Skip edges (forward):
  8_confirm   → 10_create     (skip wiki)
```

### Check Available Transitions

```bash
node lib/workflow-engine.js create-jira transitions <slug>
```

### View Full Graph

```bash
node lib/workflow-engine.js create-jira graph
```

---

## Rules

1. **FIRST tool call = workflow engine** - No text-only responses before getting the plan
2. **Call transition before each RUN step** - Validates the move is legal
3. **Re-run workflow engine after any fix** - Fresh state inspection
4. **Never claim completion without plan showing all done** - The engine is the source of truth
5. **Follow the plan exactly** - Don't skip steps, don't improvise
6. **Reference sub-documents** - Each step has detailed instructions in the linked .md files

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `workflow-engine.js create-jira plan <desc>` | Generate action plan |
| `workflow-engine.js create-jira transition <slug> <step>` | Validate & record step change |
| `workflow-engine.js create-jira transitions <slug>` | Show allowed next steps |
| `workflow-engine.js create-jira graph` | Show full state machine |
| `workflow-engine.js list` | Show all registered workflows |

---

## File Structure

```
tasks/
├── drafts/
│   └── ${slug}/
│       ├── .workflow-state.json  # Workflow engine state
│       ├── context.md            # Codebase exploration
│       ├── consensus-log.md      # Iteration tracking
│       ├── backend-v*.md         # Backend agent iterations
│       ├── frontend-v*.md        # Frontend agent iterations
│       ├── qa-v*.md              # QA agent iterations
│       ├── devops-v*.md          # DevOps agent iterations
│       ├── task-v*.md            # Unified task iterations
│       ├── final-task.md         # Final consensus version
│       └── design-doc.md         # Design doc draft (if generated)
└── design-docs/
    └── ${slug}-design-doc.md     # Published design doc
```

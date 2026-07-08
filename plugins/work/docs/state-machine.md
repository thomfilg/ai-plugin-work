# State Machine

The workflow engine is built on a deterministic state machine that tracks step progress, enforces transitions, and enables resume-on-context-loss.

## Step Registry

**File:** `scripts/workflows/work/step-registry.js`

The step registry is the single source of truth for step identifiers and ordering. Step IDs are decoupled from their position — reordering only requires changing `STEP_ORDER`.

### Step Identifiers

```javascript
const STEPS = Object.freeze({
  ticket:      'ticket',
  bootstrap:   'bootstrap',
  brief:       'brief',
  brief_gate:  'brief_gate',
  spec:        'spec',
  spec_gate:   'spec_gate',
  tasks:       'tasks',
  implement:   'implement',
  commit:      'commit',      // step 9
  task_review: 'task_review', // step 10 (GH-211)
  check:       'check',
  pr:          'pr',
  ready:       'ready',
  follow_up:   'follow_up',
  ci:          'ci',
  cleanup:     'cleanup',
  reports:     'reports',
  complete:    'complete',
});
```

### Step Ordering

```
1. ticket        — Initialize work state
2. bootstrap     — Create worktree & branch
3. brief         — Generate product brief
4. brief_gate    — Verify no blocking open questions (GH-215)
5. spec          — Generate technical spec
6. spec_gate     — Validate Gherkin test scenarios in spec (GH-244)
7. tasks         — Split spec into tasks (tasks.md)
8. implement     — TDD-gated code implementation
9. commit        — Commit changes
10. task_review  — Per-task code review gate (GH-211)
11. check        — Full quality verification
12. pr           — Create/update pull request
13. ready        — Mark PR ready for review
14. follow_up   — Monitor CI & address review comments
15. ci           — Verify CI passes
16. cleanup      — Remove dev server sessions
17. reports      — Generate approval summary
18. complete     — Terminal step
```

## Transition Graph

### Forward Edges

Each step transitions to the next step in order: `ticket → bootstrap → brief → ... → complete`.

### Backward Edges (Retry Loops)

When quality gates fail, the workflow loops back to fix issues:

```
spec_gate   → spec         (Gherkin validation failed, regenerate spec)
task_review → implement    (review found issues)
check       → implement    (check found issues)
follow_up   → implement    (PR review requires code changes)
ci          → implement    (CI failed, fix code)
```

### Self-Loop

```
complete → complete        (retry terminal step on partial failure, GH-106)
```

### Visual Graph

```
ticket → bootstrap → brief → brief_gate → spec → spec_gate → tasks
                                            ▲        │
                                            └────────┘ (Gherkin invalid)
                                                               │
    ┌──────────────────────────────────────────────────────────┘
    ▼
implement ←──────────────────────────────────────┐
    │                                             │
    ▼                                             │
commit → task_review ─── (issues found) ──────────┤
    │         │                                   │
    │         ▼ (pass)                            │
    │    check ─────────── (issues found) ────────┤
    │         │                                   │
    │         ▼ (pass)                            │
    │    pr → ready → follow_up ── (changes) ─────┤
    │                     │                       │
    │                     ▼ (pass)                │
    │                ci ──────── (failed) ────────┘
    │                     │
    │                     ▼ (pass)
    │              cleanup → reports → complete
    │                                     │
    └─────────────────────────────────────┘
                  (self-loop for retries)
```

## State Persistence

### .work-state.json

The primary state file tracks step progress:

```json
{
  "ticketId": "PROJ-123",
  "description": "",
  "currentStep": 11,
  "status": "in_progress",
  "stepStatus": {
    "ticket": "completed",
    "bootstrap": "completed",
    "brief": "completed",
    "brief_gate": "completed",
    "spec": "completed",
    "spec_gate": "completed",
    "tasks": "completed",
    "implement": "completed",
    "commit": "completed",
    "task_review": "completed",
    "check": "in_progress",
    "pr": "pending",
    "...": "pending"
  },
  "checkProgress": {},
  "errors": [],
  "startTime": "2026-04-22T11:00:36.726Z",
  "lastUpdate": "2026-04-22T14:33:38.502Z",
  "tasksMeta": {
    "totalTasks": 6,
    "currentTaskIndex": 3,
    "tasks": [
      { "id": "task_1", "status": "completed" },
      { "id": "task_2", "status": "completed" },
      { "id": "task_3", "status": "completed" },
      { "id": "task_4", "status": "pending" },
      { "id": "task_5", "status": "pending" },
      { "id": "task_6", "status": "pending" }
    ]
  },
  "deferredSteps": ["bootstrap", "brief", "brief_gate", "spec"]
}
```

### Step Statuses

| Status | Meaning |
|---|---|
| `pending` | Not yet started |
| `in_progress` | Currently active |
| `completed` | Successfully finished |
| `failed` | Failed (triggers retry) |

### Task Meta

When `tasks.md` exists, the workflow tracks per-task progress:

- `totalTasks` — Number of tasks parsed from tasks.md
- `currentTaskIndex` — 0-indexed pointer to current task
- `tasks[]` — Per-task status with `taskReviewFixRounds` counter

The implement/commit/task_review cycle repeats for each task before proceeding to check.

## Plan Generator

**File:** `scripts/workflows/work/plan-generator.js`

Before each orchestrator iteration, the plan generator inspects current state and computes actions:

| Action | Meaning |
|---|---|
| `RUN` | Execute this step now |
| `SKIP` | Step already verified, move to next |
| `DEFER` | Step needs prerequisites first |

The plan generator calls each step's `verify()` function (from `workflow-definition.js`) to determine if evidence already exists. This enables:

- **Resume** — After context loss, already-completed steps are SKIPped
- **Idempotency** — Re-running the orchestrator produces the same plan
- **Backward transitions** — After a retry loop, intermediate steps may need re-verification

## Resume on Context Loss

When Claude's context window rotates or the conversation crashes:

1. User re-invokes `/work TICKET-123`
2. Orchestrator loads `.work-state.json`
3. Plan generator runs `verify()` for each step
4. Steps with evidence → SKIP
5. First step without evidence → RUN
6. Work resumes from that point

## Workflow Engine (Generic)

**File:** `scripts/workflows/lib/workflow-engine.js`

The generic workflow engine supports any workflow (not just /work). It provides:

- `discoverWorkflows()` — Scan `scripts/workflows/` for `*.workflow.js` files
- `loadWorkflow(name)` — Load workflow definition
- `transitionStep(ticketId, step)` — Advance state machine
- `detectStepState(workflow, ticketId)` — Inspect which steps are verified

Each workflow provides a `workflow-definition.js` that returns:
- `steps` — Ordered step array
- `commandMap` — Step-to-tool-pattern mappings
- `verify()` functions — Evidence checks
- `archivalPatterns` — Cleanup rules for backward transitions
- `evidenceRequirements` — Required files per step
- `softSteps` — Steps that don't require evidence

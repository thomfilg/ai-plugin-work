# /work Workflow

The main orchestrator workflow that drives ticket-to-PR delivery through 18 deterministic steps.

## Invocation

```bash
/work TICKET-123
/work TICKET-123 "Optional description"
```

## Step Details

### 1. ticket

**Purpose:** Initialize work state and read ticket information.

**Actions:**
- Create `.work-state.json` with all steps set to `pending`
- Read ticket details from provider (Jira, Linear, GitHub)
- Store ticket description in state

**Verification:** `.work-state.json` exists and `status === 'in_progress'`

### 2. bootstrap

**Purpose:** Create git worktree and feature branch.

**Actions:**
- Create worktree at `WORKTREES_BASE/<repo>-<ticket>/`
- Create branch containing ticket ID
- Copy credentials, symlink configs
- Initialize codegraph if applicable
- Optionally open draft PR

**Verification:** Current git branch name contains ticket ID

**Deferrable:** Yes — if already on the correct branch, this step is skipped

### 3. brief

**Purpose:** Generate a structured product brief from ticket requirements.

**Agent:** `brief-writer`

**Actions:**
- Read ticket details
- Analyze requirements, constraints, dependencies
- Generate `brief.md` with sections: Problem, Goal, Requirements (P0/P1/P2), Constraints, Scope, Success Metrics, Open Questions

**Verification:** `brief.md` exists in tasks directory

**Output:** `tasks/<ticket>/brief.md`

### 4. brief_gate (GH-215)

**Purpose:** Block spec generation until all blocking open questions in the brief are resolved.

**Actions:**
- Parse `brief.md` for open questions
- Check each question: scope (cross-ticket vs local) and resolved status
- Block if any cross-ticket/architectural questions are unresolved

**Verification:** `brief.md` exists AND no blocking open questions remain

**Blocking behavior:** Uses `AskUserQuestion` to present unresolved questions to the user

### 5. spec

**Purpose:** Generate a technical specification from the brief and codebase analysis.

**Agent:** `spec-writer`

**Actions:**
- Read brief.md
- Explore codebase (architecture, patterns, existing code)
- Generate `spec.md` with: Architecture decisions, API changes, Security considerations, Gherkin test scenarios, Reuse audit, Verification checklist

**Verification:** `spec.md` exists

**Output:** `tasks/<ticket>/spec.md`, `tasks/<ticket>/gherkin.feature` (Gherkin scenarios saved as standalone file)

### 6. spec_gate (GH-244)

**Purpose:** Validate Gherkin test scenarios in the spec before task decomposition.

**Actions:**
- Parse Gherkin test scenarios from `gherkin.feature` (standalone file) or fall back to inline scenarios in `spec.md`
- Validate syntax and structure via `parse-gherkin.js`
- Check for skip override (specs can declare Gherkin validation not applicable)

**Verification:** One of:
- Spec is disabled (`WORK_SPEC_ENABLED=0`)
- `spec.md` doesn't exist (step SKIPs)
- Skip override is present in spec
- `parse()` + `validate()` passes with no errors

**Retry:** On failure, loops back to `spec` to regenerate (`spec_gate → spec`)

### 7. tasks

**Purpose:** Split the spec into ordered, deliverable tasks with requirement traceability.

**Skill:** `/split-in-tasks`

**Actions:**
- Parse spec.md
- Generate `tasks.md` with numbered tasks, dependencies, deliverables
- Each task follows RED → GREEN → REFACTOR TDD ordering
- Initialize `tasksMeta` in state with task count

**Verification:** `tasks.md` exists

**Output:** `tasks/<ticket>/tasks.md`

### 8. implement

**Purpose:** TDD-gated code implementation.

**Agents:** `developer-nodejs-tdd`, `developer-react-senior`, `developer-react-ui-architect`, `developer-devops` (auto-selected based on file types)

**TDD Cycle per task:**
1. **RED:** Write failing tests (hook blocks non-test file edits)
2. **GREEN:** Implement code to pass tests (hook blocks test file edits)
3. **REFACTOR:** Clean up (all edits allowed)

**Evidence:** `tdd-phase.json` with at least one cycle containing `red` + `green` evidence

**Per-task loop:** When `tasks.md` exists, implement runs for each task sequentially:
```
task 1: implement → commit → task_review → advance
task 2: implement → commit → task_review → advance
...
task N: implement → commit → task_review → check
```

**Exception mode:** For config-only/mechanical changes, `tdd-phase-state.js exception` records a reason and bypasses TDD. See [TDD Enforcement](./tdd-enforcement.md).

### 9. commit

**Purpose:** Commit implemented changes.

**Agent:** `commit-writer`

**Actions:**
- Stage relevant files
- Generate semantic commit message
- Create commit (with autonomous flag — no confirmation prompt)

**Verification:** HEAD has new non-empty commits compared to base branch

### 10. task_review (GH-211)

**Purpose:** Per-task code review after each commit.

**Soft step** — advisory, does not hard-block progression.

**Actions:**
- Run lightweight tests review on the task's diff
- Run code review on the task's diff
- Generate task-review artifacts

**Fix rounds:** If issues found, loop back to implement (max `TASK_REVIEW_MAX_FIXES` rounds, default 2)

**Verification:** Review artifacts exist (`task-review-tests.md` or `task-review-code.md`)

### 11. check

**Purpose:** Full quality verification across all tasks.

**Delegates to:** `/check` workflow (see [/check Workflow](./workflow-check.md))

**Reports required:**
- `code-review.check.md` (APPROVED)
- `tests.check.md` (APPROVED)
- `completion.check.md` (APPROVED/COMPLETE)
- At least one `qa-*.check.md` (APPROVED)
- `README.md` (summary with changes hash)

**Verification:** All required report files exist

### 12. pr

**Purpose:** Create or update the pull request.

**Agent:** `pr-generator`

**Actions:**
- Analyze full branch diff
- Generate PR title and description
- Create PR via `gh pr create` or update via `gh pr edit`

**Verification:** Open PR exists for current branch (`gh pr view`)

### 13. ready

**Purpose:** Mark PR as ready for review.

**Soft step** — user/agent signals readiness.

### 14. follow_up

**Purpose:** Monitor PR for CI status and review comments.

**Actions:**
- Check PR comments (Copilot, human reviewers)
- Build `review-accountability.json` — every comment must be accounted for
- Dispositions: `fixed`, `acknowledged` (requires user approval), `not_applicable`
- If code changes needed: loop back to implement

**Verification:** `isPRGateReady()` returns true AND all comments accounted for

### 15. ci

**Purpose:** Verify CI checks pass.

**Verification:** `gh pr checks` shows all checks passing

**Retry:** If CI fails, loop back to implement to fix

### 16. cleanup

**Purpose:** Remove development server sessions.

**Actions:**
- Kill tmux session `<ticket>-dev`
- Clean up any running processes

**Verification:** No tmux session exists for this ticket

### 17. reports

**Purpose:** Validate final approval status.

**Verification:** All check reports contain `Status: APPROVED` or `Status: COMPLETE`. At least one QA report exists and passes.

### 18. complete

**Purpose:** Terminal step.

**Soft step** — marks state as `completed`. Self-loop allows retry on partial failure (GH-106).

## Multi-Task Mode

When `tasks.md` exists with multiple tasks, the implement/commit/task_review cycle runs per-task:

```
                  ┌────────────────────────┐
                  ▼                        │
Task N: implement → commit → task_review ──┘ (if fix needed)
                                    │
                                    ▼ (pass)
                            task-advance
                                    │
                                    ▼
                            Next task or → check
```

State tracking:
- `tasksMeta.currentTaskIndex` — 0-indexed pointer
- `tasksMeta.tasks[i].status` — `pending` or `completed` (active task is identified by `currentTaskIndex`, not a separate status)
- `tasksMeta.tasks[i].taskReviewFixRounds` — Fix round counter (resets per task)

## Plan Actions

The orchestrator generates a plan before each iteration:

| Action | Meaning | When |
|---|---|---|
| `RUN` | Execute this step | Step not yet verified |
| `SKIP` | Already done | Step verified (file exists, git state correct) |
| `DEFER` | Wait for prerequisites | Step depends on unfinished work |

## Deferred Steps

Steps may be deferred when:
- They were already completed in a previous context (e.g., bootstrap on resume)
- The orchestrator marks them as not needing re-execution
- Listed in `state.deferredSteps[]`

## Error Handling

- Errors are recorded in `state.errors[]` with `{step, error, timestamp}`
- The orchestrator surfaces errors and may retry or escalate
- Maximum retry attempts are step-specific (e.g., `TASK_REVIEW_MAX_FIXES=2`)

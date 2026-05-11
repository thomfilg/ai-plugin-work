# /work Workflow

Orchestrated workflow for ticket tasks with deterministic step execution.

## Directory Structure

```
workflows/work/
  README.md              ← this file
  check-gate.js          ← check→pr transition gate (extracted from orchestrator)
  skills/                ← skill definitions (source of truth)
    work.md              ← skills/work/SKILL.md (symlink)
    bootstrap.md         ← skills/bootstrap/SKILL.md (symlink)
    brief.md             ← skills/brief/SKILL.md (symlink)
    spec.md              ← skills/spec/SKILL.md (symlink)
    follow-up-pr.md      ← skills/follow-up-pr/SKILL.md (symlink)
    orchestrate.md       ← skills/orchestrate/SKILL.md (symlink)
```

## Hooks

| Hook | Path | Purpose |
|------|------|---------|
| work-orchestrator | `hooks/work-orchestrator.js` | Main orchestrator: plan generation, transitions, state machine |
| work-state | `hooks/work-state.js` | Work state persistence (`.work-state.json`) |
| enforce-step-workflow | `hooks/enforce-step-workflow.js` | Step enforcement, artifact protection, verify |
| session-guard | `hooks/session-guard.js` | Session locking for workflow isolation |
| enforce-work-command | `hooks/enforce-work-command.js` | Enforce work command constraints |
| enforce-completion-protocol | `hooks/enforce-completion-protocol.js` | Enforce completion checklist |
| work-enforce-steps | `hooks/work-enforce-steps.js` | Enforce skill execution order |
| work-implement-enforce | `hooks/work-implement-enforce.js` | Enforce /work-implement constraints |
| work-require-implement | `hooks/work-require-implement.js` | Require /work-implement execution |
| work-code-review-status | `hooks/work-code-review-status.js` | Track code review status |
| work-suggestion-replies | `hooks/work-suggestion-replies.js` | Handle suggestion replies |

### Check Phase Hooks

| Hook | Path | Purpose |
|------|------|---------|
| check-setup | `hooks/check-setup.js` | Setup variables, hash, cache check |
| check-start-env | `hooks/check-start-env.js` | Start dev environment (database, apps) |
| check-determine-developers | `hooks/check-determine-developers.js` | Select developer agents for consensus |
| check-validate-reports | `hooks/check-validate-reports.js` | Validate report completeness |
| check-generate-summary | `hooks/check-generate-summary.js` | Generate README.md summary |

### Agent-Specific Hooks

| Hook | Path | Purpose |
|------|------|---------|
| commit-writer | `hooks/agents/commit-writer/` | Commit message preflight and write blocking |
| pr-generator | `hooks/agents/pr-generator/` | PR validation and readonly guard |
| pr-post-generator | `hooks/agents/pr-post-generator/` | PR post-generation validation |
| qa-feature-tester | `hooks/agents/qa-feature-tester/` | QA agent start, stop, screenshot validation |
| qa-api-tester | `hooks/agents/qa-api-tester/` | API report validation |

## Scripts

| Script | Path | Purpose |
|--------|------|---------|
| follow-up-pr | `scripts/follow-up-pr.js` | Monitor PR CI, auto-fix failures, address review feedback |

## Extracted Modules

| Module | Path | Purpose |
|--------|------|---------|
| check-gate | `workflows/work/check-gate.js` | Declarative CHECK_GATE_RULES array for check→pr validation |
| work-state | `workflows/work/work-state.js` | Workflow state persistence (`.work-state.json`), task tracking, re-exports claim/worker APIs |
| work-actions | `workflows/work/work-actions.js` | Action logging + enforcement audit records (`.work-actions.json`) |
| work-claims | `workflows/work/work-claims.js` | Atomic per-task claim locks under `.claims/` |
| task-readiness | `workflows/work/work-state/task-readiness.js` | Dependency readiness checks (`canStart`, `initTasksMeta`) |
| graph-validation | `workflows/work/work-state/graph-validation.js` | Task dependency DAG validation (cycles, unknown deps, self-deps) |
| parallel-workers | `workflows/work/work-state/parallel-workers.js` | PR{N} slot allocation and release |
| preflight | `workflows/lib/preflight.js` | Unified enforcement gate with audit callback |
| allocate-output-folder | `workflows/lib/allocate-output-folder.js` | Output folder routing (in-flow task${N}/, out-of-flow) |
| request-index | `workflows/lib/request-index.js` | Atomic counter ledger for out-of-flow request allocation |
| ticket-validation | `workflows/lib/ticket-validation.js` | Shared ticket ID validation and sanitization |

## Enforcement Record Format

Action records in `.work-actions.json` use a discriminator to distinguish legacy step rows from enforcement audit entries:

```
Legacy rows:    { step, timestamp, what, meta? }
Enforcement:    { kind: 'enforcement', timestamp, origin, task, phase, action, allow, reason, outputPath, meta? }
```

## Step Flow

```
ticket → bootstrap → brief → spec → implement → commit → check → pr → ready → follow_up → ci → cleanup → reports → complete
```

## Key Files (lib/)

| File | Purpose |
|------|---------|
| `lib/step-registry.js` | Step constants, transitions, state machine |
| `lib/workflow-engine.js` | Workflow step execution engine |
| `lib/workflow-state.js` | Workflow state management |
| `lib/work-actions.js` | Action logging |
| `lib/ticket-provider.js` | Ticket provider abstraction (Jira, GitHub, Linear) |
| `lib/agent-detection.js` | Agent type detection |
| `lib/config.js` | Configuration management |

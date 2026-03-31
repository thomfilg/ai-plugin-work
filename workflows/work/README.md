# /work Workflow

Orchestrated workflow for ticket tasks with deterministic step execution.

## Directory Structure

```
workflows/work/
  README.md              ← this file
  check-gate.js          ← check→pr transition gate (extracted from orchestrator)
  skills/                ← symlinks to skill definitions
    work.md              → skills/work/SKILL.md
    work-implement.md    → skills/work-implement/SKILL.md
    work-pr.md           → skills/work-pr/SKILL.md
    check.md             → skills/check/SKILL.md
    check-qa.md          → skills/check-qa/SKILL.md
    check-browser.md     → skills/check-browser/SKILL.md
    bootstrap.md         → skills/bootstrap/SKILL.md
    brief.md             → skills/brief/SKILL.md
    spec.md              → skills/spec/SKILL.md
    follow-up-pr.md      → skills/follow-up-pr/SKILL.md
    test-coordination.md → skills/test-coordination/SKILL.md
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

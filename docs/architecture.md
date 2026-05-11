# Architecture Overview

## System Design

`claude-plugin-work` is a Claude Code plugin that provides deterministic, state-machine-driven workflows for software development. It transforms ticket requirements into merged PRs through a pipeline of specialized agents, enforced by hooks that gate tool usage based on workflow state.

### Design Principles

1. **Deterministic orchestration** — A state machine guarantees exact step execution order. No step is skipped unless explicitly planned (SKIP/DEFER).
2. **Evidence-based gates** — Steps must produce verifiable evidence (files, git state, test results) before the workflow can progress.
3. **Fail-open hooks** — All enforcement hooks exit 0 on internal errors (allow tool use). Only intentional blocks return exit code 2.
4. **Agent specialization** — 19 domain-specific agents handle different concerns. No agent self-reports evidence; external scripts record it.
5. **Resume on context loss** — Persistent state files allow the workflow to resume from the last completed step after a crash or context window rotation.

## Directory Structure

```
claude-plugin-work/
├── scripts/workflows/                  # Core workflow engine & definitions
│   ├── lib/                    # Shared utilities
│   │   ├── workflow-engine.js  # Reusable state machine engine
│   │   ├── workflow-state.js   # Generic state persistence
│   │   ├── config.js           # Centralized config loader
│   │   ├── ticket-provider.js  # Provider abstraction (Jira/Linear/GitHub)
│   │   ├── allocate-output-folder.js  # Output directory routing
│   │   ├── agent-detection.js  # Identify running agent context
│   │   ├── hook-error-log.js   # Error logging (not stderr)
│   │   ├── ticket-validation.js # Path traversal protection
│   │   ├── hooks/              # Shared enforcement hooks
│   │   │   ├── enforce-step-workflow.js  # Master step gating
│   │   │   └── policies/       # Pure decision functions
│   │   │       ├── command-matching.js
│   │   │       ├── agent-authorization.js
│   │   │       ├── state-protection.js
│   │   │       ├── evidence-recorder.js
│   │   │       ├── step-gate.js
│   │   │       └── transition-gate.js
│   │   └── scripts/            # Utility scripts
│   ├── work/                   # /work orchestrator
│   │   ├── work.workflow.js    # Main dispatcher
│   │   ├── workflow-definition.js  # Declarative config
│   │   ├── step-registry.js    # Step ID + ordering registry
│   │   ├── steps/              # Per-step handlers
│   │   ├── hooks/              # /work-specific hooks
│   │   ├── scripts/            # /work scripts
│   │   ├── work-state.js       # /work state extensions
│   │   ├── plan-generator.js   # RUN/SKIP/DEFER planner
│   │   ├── inspect.js          # Filesystem state inspector
│   │   ├── check-gate.js       # Quality verification gate
│   │   ├── artifact-archival.js # Backward transition cleanup
│   │   └── tdd-enforcement.js  # TDD evidence validation
│   ├── work-implement/         # TDD phase management
│   │   ├── tdd-phase-state.js  # TDD CLI (record-red, record-green, etc.)
│   │   ├── tdd-phase-registry.js  # Phase definitions & transitions
│   │   └── hooks/              # TDD file gating
│   ├── work-pr/                # PR generation workflow
│   └── check/                  # Quality verification workflow
│       ├── check.workflow.js   # Check dispatcher
│       ├── hooks/              # Check-specific hooks
│       └── scripts/            # Report writers
├── agents/                     # 19 specialized agent definitions (markdown)
├── skills/                     # 23 slash command definitions (SKILL.md)
├── hooks/                      # Hook registration (hooks.json)
├── scripts/                    # Root-level scripts
└── package.json                # Dependencies (biome only)
```

## Data Flow

```
User invokes /work TICKET-123
         │
         ▼
┌─────────────────────────────────────┐
│  work.workflow.js (orchestrator)    │
│  Reads .work-state.json            │
│  Runs plan-generator.js            │
│  Outputs: RUN / SKIP / DEFER       │
└──────────┬──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│  Per-step handler (steps/*.js)      │
│  Dispatches agent via Task()        │
│  Agent produces artifacts           │
└──────────┬──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│  enforce-step-workflow.js (hooks)   │
│  PreToolUse: gate tool usage        │
│  PostToolUse: record evidence       │
│  Blocks unauthorized tool calls     │
└──────────┬──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│  workflow-definition.js (verify)    │
│  Checks file existence, git state   │
│  Evaluates evidence requirements    │
│  Returns: verified / not verified   │
└──────────┬──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│  transition-step.js                 │
│  Advances to next step              │
│  Triggers artifact archival         │
│  Updates .work-state.json           │
└─────────────────────────────────────┘
```

## Component Interactions

### Orchestrator → Agents

The orchestrator dispatches agents via `Task()` tool calls. Each step maps to one or more agents:

| Step | Agent(s) |
|---|---|
| brief | brief-writer |
| spec | spec-writer |
| implement | developer-nodejs-tdd, developer-react-senior, developer-devops |
| check | code-checker, quality-checker, qa-feature-tester, completion-checker |
| pr | pr-generator |
| commit | commit-writer |

### Hooks → Workflows

Hooks intercept prompt and tool events and delegate to workflow-specific logic:

1. `workflow-router-hook.js` routes `UserPromptSubmit` events to workflow-specific prompt logic
2. `enforce-step-workflow.js` identifies which workflow is active for tool gating (by loading each workflow's state file and evaluating `isActive(state)`), then applies step gating rules
3. Workflow-specific hooks add domain logic (TDD phase gating, screenshot requirements)

### State → Filesystem

All state persists to the filesystem under `TASKS_BASE/<ticket>/`:

```
tasks/TICKET-123/
├── .work-state.json           # Step progress
├── .work-actions.json         # Audit trail
├── brief.md                   # Brief artifact
├── spec.md                    # Spec artifact
├── tasks.md                   # Task decomposition
├── tdd-phase.json             # Root TDD state (legacy)
├── task1/                     # Per-task artifacts (GH-219)
│   └── tdd-phase.json
├── task2/
│   └── tdd-phase.json
├── code-review.check.md       # Check reports
├── tests.check.md
├── completion.check.md
├── qa-myapp.check.md
├── README.md                  # Check summary with hash
├── screenshots/               # QA screenshots
└── runs/                      # Archived reports from prior check runs
    ├── run1/
    └── run2/
```

## Zero Runtime Dependencies

The plugin has no runtime npm dependencies. Only `@biomejs/biome` is listed as a devDependency for code formatting. All logic is pure Node.js using built-in modules (`fs`, `path`, `child_process`, `crypto`).

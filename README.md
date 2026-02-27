# work-workflow

A Claude Code plugin that provides deterministic workflow orchestration for Jira task implementation. It uses a state machine engine to enforce exact step execution, ensuring consistent and reliable development workflows.

## Features

- **Deterministic Workflow Engine** - State machine-driven step execution with forward/backward transitions
- **Jira Integration** - Automatically fetches task details, transitions issue status, and links PRs
- **Quality Enforcement** - Built-in hooks enforce screenshot requirements, step ordering, and code review
- **Parallel Agent Orchestration** - Delegates work to specialized sub-agents (TDD, React, DevOps, QA) while keeping the orchestrator context lean
- **Multi-task Support** - Bootstrap and orchestrate multiple Jira tasks across isolated git worktrees

## Installation

Run these commands inside a Claude Code session:

```
/plugin marketplace add tigredonorte/claude-plugin-work
/plugin install work-workflow
```

For local development, point to a local directory instead:

```
/plugin marketplace add ./path/to/claude-plugin-work
```

## Available Skills (Slash Commands)

### Core Workflow

| Command | Description |
|---------|-------------|
| `/work <TICKET_ID>` | Full orchestrated workflow: fetch Jira task, branch, implement, test, review, PR |
| `/work <TICKET_ID> --rework` | Re-run quality checks and PR update on an existing implementation |
| `/work-implement <TICKET_ID>` | Quick implementation without the full workflow ceremony |
| `/work-pr <TICKET_ID>` | Update PR description and add visual documentation |

### Quality & Testing

| Command | Description |
|---------|-------------|
| `/check <TICKET_ID>` | Run full quality check: lint, typecheck, tests, code review, QA, and requirements verification in parallel |
| `/check-qa <app>` | Run QA testing for a specific app using Playwright |
| `/check-browser` | Verify browser/UI state using API-first approach with browser fallback |

### Test Management

| Command | Description |
|---------|-------------|
| `/test-coordination` | Coordinate test enhancement: reviews coverage and creates missing tests in parallel |
| `/tests-review` | Review test edge case coverage iteratively |
| `/tests-create` | Implement missing test edge cases using the appropriate developer agent |

### Multi-task Operations

| Command | Description |
|---------|-------------|
| `/bootstrap <TICKET_IDs...>` | Setup multiple Jira tasks: creates worktrees, symlinks configs, opens draft PRs |
| `/orchestrate <TICKET_IDs...>` | Runs `/work` for multiple Jira tasks sequentially in isolated worktrees |

### CI/CD

| Command | Description |
|---------|-------------|
| `/follow-up-pr` | Monitor PR CI status, auto-fix failures, and retry until passing (max 10 attempts) |

## Hooks

The plugin registers hooks that enforce workflow discipline:

- **`enforce-step-workflow`** - Validates that steps execute in the correct order during `/work` sessions
- **`enforce-screenshot-requirement`** - Ensures QA screenshots are captured before completing checks
- **`work-orchestrator-hook`** - Pre-processes `/work` commands to initialize the workflow engine

## Architecture

```
claude-plugin-work/
├── .claude-plugin/        # Plugin metadata (plugin.json, marketplace.json)
├── hooks/                 # Event hooks for workflow enforcement
│   ├── hooks.json         # Hook registration config
│   ├── enforce-step-workflow.js
│   ├── enforce-screenshot-requirement.js
│   └── work-orchestrator-hook.js
├── lib/                   # Core engine
│   ├── workflow-engine.js # Reusable state machine engine
│   ├── workflow-state.js  # Workflow state persistence
│   └── work-actions.js    # Step action implementations
├── skills/                # Slash command definitions (SKILL.md per command)
│   ├── work/
│   ├── check/
│   ├── bootstrap/
│   └── ...
├── workflows/             # Workflow definitions (step graphs + state detection)
│   ├── check.workflow.js
│   └── work-pr.workflow.js
└── package.json
```

### Workflow Engine

The workflow engine (`lib/workflow-engine.js`) provides:

- **Plan generation** - Detects current state and computes remaining steps
- **State transitions** - Records forward/backward step transitions with validation
- **Workflow graph** - Defines step dependencies and execution order
- **Step state detection** - Automatically determines which steps are already complete (e.g., branch exists, PR is open)

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Atlassian MCP server](https://github.com/anthropics/claude-code) configured for Jira integration
- Git and GitHub CLI (`gh`) available in your environment
- Node.js 18+

## License

MIT

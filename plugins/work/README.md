# work-workflow

A Claude Code plugin that provides deterministic workflow orchestration for Jira task implementation. It uses a state machine engine to enforce exact step execution, ensuring consistent and reliable development workflows.

## Features

- **Deterministic Workflow Engine** - State machine-driven step execution with forward/backward transitions
- **Jira Integration** - Automatically fetches task details, transitions issue status, and links PRs
- **Quality Enforcement** - Built-in hooks enforce screenshot requirements, step ordering, and code review
- **Brief & Spec Generation** - Optional stages that produce a product brief and technical spec (with Given/When/Then test scenarios) before implementation
- **Planning Artifact Discovery** - Agents auto-discover brief.md, spec.md, and pre-planning.md to validate deliverables, reuse components, and structure QA tests
- **Parallel Agent Orchestration** - Delegates work to 18 specialized sub-agents (TDD, React, DevOps, QA, brief-writer, spec-writer) while keeping the orchestrator context lean
- **Multi-task Support** - Bootstrap and orchestrate multiple Jira tasks across isolated git worktrees

## Installation

Run these commands inside a Claude Code session:

```
/plugin marketplace add your-org/claude-plugin-work
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
| `/check2 <TICKET_ID>` | Run full quality check: lint, typecheck, tests, code review, QA, and requirements verification in parallel |
| `/check-qa <app>` | Run QA testing for a specific app using Playwright |
| `/check-browser` | Verify browser/UI state using API-first approach with browser fallback |

### Test Management

| Command | Description |
|---------|-------------|
| `/test-coordination` | Coordinate test coverage improvement: reviews coverage and creates missing tests in parallel |
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
| `/follow-up` | Monitor PR CI status, auto-fix failures, and retry until passing (max 10 attempts) |

## Hooks

The plugin registers hooks that enforce workflow discipline:

- **`enforce-step-workflow`** - Validates that steps execute in the correct order during `/work` sessions
- **`enforce-screenshot-requirement`** - Ensures QA screenshots are captured before completing checks
- **`work-orchestrator-hook`** - Pre-processes `/work` commands to initialize the workflow engine

## Architecture

```
claude-plugin-work/
├── .claude-plugin/               # Plugin metadata (plugin.json, marketplace.json)
├── hooks/                        # Top-level event hooks
│   ├── hooks.json                # Hook registration config
│   └── work-orchestrator-hook.js
├── scripts/workflows/                    # Workflow definitions and core engine
│   ├── lib/                      # Core engine and shared hook utilities
│   │   ├── workflow-engine.js    # Reusable state machine engine
│   │   ├── workflow-state.js     # Workflow state persistence
│   │   ├── hook-error-log.js     # Hook error file logger (see Debugging Hooks)
│   │   └── hooks/                # Shared hooks (enforce-step-workflow, etc.)
│   ├── work/                     # /work orchestrator workflow
│   ├── check/                    # /check2 workflow
│   └── work-pr/                  # /work-pr workflow
├── agents/                       # Agent definitions (18 specialized agents)
│   ├── brief-writer.md           # Product brief generation
│   ├── spec-writer.md            # Technical spec generation
│   ├── developer-nodejs-tdd.md
│   ├── code-checker.md
│   └── ...
├── skills/                       # Slash command definitions (SKILL.md per command)
│   ├── work/
│   ├── check/
│   ├── bootstrap/
│   └── ...
└── package.json
```

### Workflow Engine

The workflow engine (`scripts/workflows/lib/workflow-engine.js`) provides:

- **Plan generation** - Detects current state and computes remaining steps
- **State transitions** - Records forward/backward step transitions with validation
- **Workflow graph** - Defines step dependencies and execution order
- **Step state detection** - Automatically determines which steps are already complete (e.g., branch exists, PR is open)

## Debugging Hooks

Hook errors are logged to a file instead of stderr to prevent false "hook error" noise in Claude Code.

**Log locations:**
- **Plugin hooks:** `/tmp/claude-hook-errors.log` (default)
- **Personal hooks (`~/.claude/hooks/`):** Same file — `/tmp/claude-hook-errors.log`
- **Custom path:** Set `HOOK_ERROR_LOG=/path/to/file.log`

**Log format:**
```
[2026-03-30T18:33:01.123Z] enforce-step-workflow.js | pid=12345 branch=feature/PROJ-123 cwd=/repo/path | WORKTREES_BASE: env var not set
```

**To enable verbose stderr output (shows errors in Claude Code):**
```bash
export ENFORCE_HOOK_DEBUG=1
```

**Auto-rotation:** Log file is truncated when it exceeds 1MB.

**Race conditions:** Each log line includes PID. Writes use `O_APPEND` with short lines (~3.8KB max). On Linux ext4/xfs, these are effectively atomic across concurrent instances.

**Source files:**
- `scripts/workflows/lib/hook-error-log.js` (plugin hooks)
- `~/.claude/hooks/lib/hook-error-log.js` (personal hooks — identical copy)

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Atlassian MCP server](https://github.com/anthropics/claude-code) configured for Jira integration
- Git and GitHub CLI (`gh`) available in your environment
- Node.js 18+

## License

MIT

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

### Codex CLI

The same plugin installs natively on Codex CLI (0.142.5+):

```
codex plugin marketplace add thomfilg/claude-plugin-work
codex plugin add work-workflow@work-workflow
```

Then run the one-time TUI `/hooks` trust review — codex **silently skips
untrusted hooks**, so until then every workflow gate is off. `/work` is invoked
as a skill mention (`$work GH-N`) rather than a slash command; subagents run
inline (serialized) and interactive gates degrade per the
`[work:codex-degraded]` notices. Details: the repo-root `README.md` install
matrix and `docs/hooks.md` → "Dual runtime".

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
| `/test-coordination` | Coordinate test coverage improvement: reviews coverage and creates missing tests in parallel |
| `/tests-review` | Review test edge case coverage iteratively |
| `/tests-create` | Implement missing test edge cases using the appropriate developer agent |

### Multi-task Operations

| Command | Description |
|---------|-------------|
| `/bootstrap <TICKET_IDs...>` | Setup multiple Jira tasks: creates worktrees, symlinks configs, opens draft PRs |

> **Running `/work` for multiple tickets?** Use the maestro plugin's `/orchestrate` skill — it owns multi-agent orchestration (parallel tmux sessions per ticket, auto-restart, operator hand-off). The work plugin no longer ships a duplicate `/orchestrate`.

### CI/CD

| Command | Description |
|---------|-------------|
| `/follow-up` | Monitor PR CI status, auto-fix failures, and retry until passing (max 10 attempts) |

## Hooks

The plugin registers hooks that enforce workflow discipline:

- **`enforce-step-workflow`** - Validates that steps execute in the correct order during `/work` sessions
- **`enforce-screenshot-requirement`** - Ensures QA screenshots are captured before completing checks
- **`work-orchestrator-hook`** - Pre-processes `/work` commands to initialize the workflow engine

## Commits

The `commit-writer` subagent was **removed** (GH-539). Instead:

- The **session agent authors the commit message** inline (it has the context), then commits
  through the sanctioned script **`commit-and-push.js`**, which stages (`git add -A`),
  validates, commits, and pushes. No subagent dispatch.
- The **always-on `enforce-agent-usage` PreToolUse hook FORCES it**: a raw `git commit` is
  **always blocked** (exit 2) and the agent is told to run `commit-and-push.js`. There is no
  install step and no bypass — the script is the only path, so a commit can never skip
  validation. (`--amend` / `--allow-empty` / `fixup!` / `squash!` are exempt.)
- The script enforces the rules from a single source of truth
  (`scripts/workflows/work/hooks/commit-msg-rules.js`) and **rejects** a bad commit:
  - **semantic format** (`type(scope): description`, allowed types, ≤72-char title, no trailing
    period, no emoji, imperative mood, ≤100-char body lines);
  - **no AI/tool attribution** (`Co-Authored-By: Claude`, `Generated with Codex`, etc.);
  - **a human git identity** — the committing `user.name`/`user.email` must not be an AI tool
    (`claude`, `codex`, `gemini`, …). The identity is the worktree's effective git user (its
    local config when a worktree `.envrc` set it up, else the global user).

### Commit-message rule decisions

- **Title ≤ 72 chars, body lines ≤ 100 chars.** The ticket's "≤72" refers to the commit
  **title**; body lines use the ≤100 limit. Both live in `commit-msg-rules.js`
  (`titleLengthRule`, `bodyLineLengthRule`).
- **Deferred:** a `no empty body when type is feat/breaking` rule is **not** enforced yet. It
  is deferred pending team confirmation on whether to **block** or merely **warn**, and is
  intentionally omitted from `commit-msg-rules.js` until that decision lands.

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
│   ├── check/                    # /check workflow
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
- `scripts/workflows/lib/hook-error-log.js` (plugin hooks — a delegate re-exporting the vendored `scripts/workflows/lib/hookEntrypoint/logHookError.js` port; the implementation master is `factories/hookEntrypoint/logHookError.js`, kept in sync by `scripts/sync-vendored.js`)
- `~/.claude/hooks/lib/hook-error-log.js` (personal hooks — standalone copy of the same logger)

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [Atlassian MCP server](https://github.com/anthropics/claude-code) configured for Jira integration
- Git and GitHub CLI (`gh`) available in your environment
- Node.js 18+

## License

MIT

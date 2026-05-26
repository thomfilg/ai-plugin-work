# Agents

The plugin uses 19 specialized agents, each defined as a markdown file in `agents/`. Agents are dispatched via `Task()` tool calls — they never self-invoke or call other agents recursively.

## Agent Catalog

### Planning Agents

| Agent | File | Role |
|---|---|---|
| **brief-writer** | `agents/brief-writer.md` | Generate product briefs from ticket requirements |
| **spec-writer** | `agents/spec-writer.md` | Generate technical specs from briefs + codebase analysis |
| **code-architect** | `agents/code-architect.md` | Architecture review and design guidance |

### Developer Agents

| Agent | File | Domain |
|---|---|---|
| **developer-nodejs-tdd** | `agents/developer-nodejs-tdd.md` | Node.js/Express/NestJS backend, strict TDD |
| **developer-react-senior** | `agents/developer-react-senior.md` | React frontend, complex architecture |
| **developer-react-ui-architect** | `agents/developer-react-ui-architect.md` | UI components, visual design, animations |
| **developer-devops** | `agents/developer-devops.md` | Infrastructure, CI/CD, deployment |

### Quality Agents

| Agent | File | Role |
|---|---|---|
| **code-checker** | `agents/code-checker.md` | Static code review, compliance checking |
| **quality-checker** | `agents/quality-checker.md` | Lint, typecheck, unit/integration tests |
| **completion-checker** | `agents/completion-checker.md` | Requirement coverage verification |
| **qa-feature-tester** | `agents/qa-feature-tester.md` | UI testing via Playwright MCP |
| **qa-api-tester** | `agents/qa-api-tester.md` | API/backend testing via curl/HTTP |
| **pr-reviewer** | `agents/pr-reviewer.md` | Pull request code review |

### PR & Commit Agents

| Agent | File | Role |
|---|---|---|
| **pr-generator** | `agents/pr-generator.md` | Generate PR titles and descriptions from diffs |
| **pr-post-generator** | `agents/pr-post-generator.md` | Add visual documentation to PRs |
| **commit-writer** | `agents/commit-writer.md` | Generate semantic commit messages |

### Coordination Agents

| Agent | File | Role |
|---|---|---|
| **project-coordinator** | `agents/project-coordinator.md` | Cross-agent task orchestration |
| **jira-task-creator** | `agents/jira-task-creator.md` | Ticket creation with template validation |

## Dispatch Rules

### Automatic dispatch by step

The `/work` orchestrator selects agents based on the current step:

| Step | Agent(s) dispatched |
|---|---|
| brief | brief-writer |
| spec | spec-writer |
| tasks | (skill: split-in-tasks) |
| implement | developer-* (auto-selected) |
| commit | commit-writer |
| check | code-checker, quality-checker, qa-*, completion-checker (parallel) |
| pr | pr-generator |

### Developer agent selection

During the `implement` step, the developer agent is selected based on changed file types and project context:

- **React/TypeScript frontend** → `developer-react-senior`
- **Node.js backend** → `developer-nodejs-tdd`
- **Infrastructure/config** → `developer-devops`
- **UI-heavy with design focus** → `developer-react-ui-architect`

### QA agent routing

During the `check` step, QA agents are dispatched based on the `WEB_APPS` manifest:

- Apps with `appType: "web"` → `qa-feature-tester` (browser automation)
- Apps with `appType: "api"` → `qa-api-tester` (HTTP testing)
- Apps with `appType: "cli"` → No QA agent
- No `WEB_APPS` configured → QA skipped

## Agent Authorization

Certain scripts are gated to specific agents (defined in `workflow-definition.js`):

| Script | Authorized Agents | Step |
|---|---|---|
| `write-qa-report.js` | qa-feature-tester, qa-api-tester | check |
| `write-tests-report.js` | quality-checker | check |
| `write-code-review.js` | code-checker | check |
| `write-completion-report.js` | completion-checker | check |
| `tdd-phase-state.js` | developer-nodejs-tdd, developer-react-senior, developer-react-ui-architect, developer-devops | implement |

If an unauthorized agent attempts to call a gated script, the hook blocks it with an error message identifying the expected agent.

## Agent Identity Detection

**File:** `scripts/workflows/lib/agent-detection.js`

Agent identity is determined from the Claude Code transcript:

- `isRunningInAgent(transcriptPath, agentNames)` — Scans transcript for agent dispatch context
- `normalizeAgentName()` — Standardizes names (e.g., `developer_nodejs_tdd` → `developer-nodejs-tdd`)

## Consensus Loop (Phase 2 of /check)

When the code-checker reports IMPORTANT or SUGGESTION findings:

1. A developer agent evaluates each finding:
   - `IMPLEMENTED` — Code was changed to address the finding
   - `DEFERRED` — Valid finding but out of scope
   - `NOT_APPLICABLE` — Disagrees with the finding

2. The code-checker validates the developer's decisions:
   - `AGREE` — Accepts the resolution
   - `DISAGREE` — Requests re-evaluation

3. Loop continues until consensus or max iterations

The developer agent for phase 2 is auto-selected based on changed file types (same rules as implement step).

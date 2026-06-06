# Agents

19 specialized agents in `agents/`. Dispatched via `Task()` — never self-invoke recursively.

For project overview and development rules see **[CLAUDE.md](./CLAUDE.md)**.
For detailed documentation see **[docs/README.md](./docs/README.md)**.

## Review guidelines

- This is a Claude Code plugin — **CommonJS only** (`require`/`module.exports`). Do not suggest ES modules.
- **No TypeScript** — plain JavaScript. Do not suggest adding types or `.d.ts` files.
- Tests use **`node:test`** + **`node:assert/strict`**. Do not suggest Jest, Vitest, or Mocha.
- Hooks use `process.exit(0/1/2)` intentionally — 0=allow, 2=block. Do not suggest throwing errors instead.
- **Fail-open is intentional** — hooks catch errors and exit 0. Do not suggest fail-closed alternatives.
- `logHookError(__filename, err)` is the logging convention. Do not suggest `console.error`.
- Config lives in `scripts/workflows/lib/config.js` — do not duplicate its logic elsewhere.
- `Object.create(null)` prevents prototype pollution — intentional, do not flag.
- Content inside `skills/**/SKILL.md` and `agents/*.md` are AI instruction documents, not executable code. Do not flag code fences inside them.
- `protect-state-files.js` four-vector design is intentional. Do not simplify regex patterns.
- Shell command interpolation from git commands (not user input) is safe — do not flag as injection.

## Catalog

### Planning
| Agent | Role |
|---|---|
| `brief-writer` | Product briefs from ticket requirements |
| `spec-writer` | Technical specs from briefs + codebase analysis |
| `code-architect` | Architecture review and design guidance |

### Development
| Agent | Domain |
|---|---|
| `developer-nodejs-tdd` | Node.js/Express/NestJS, strict TDD |
| `developer-react-senior` | React frontend, complex architecture |
| `developer-react-ui-architect` | UI components, visual design |
| `developer-devops` | Infrastructure, CI/CD, deployment |

### Quality
| Agent | Role |
|---|---|
| `code-checker` | Static code review, compliance |
| `quality-checker` | Lint, typecheck, unit/integration tests |
| `completion-checker` | Requirement coverage verification |
| `qa-feature-tester` | UI testing via Playwright MCP |
| `qa-api-tester` | API/backend testing via curl |
| `pr-reviewer` | Pull request code review |

### PR & Commit
| Agent | Role |
|---|---|
| `pr-generator` | PR titles and descriptions from diffs |
| `pr-post-generator` | Visual documentation for PRs |
| `commit-writer` | Semantic commit messages |

### Coordination
| Agent | Role |
|---|---|
| `project-coordinator` | Cross-agent task orchestration |
| `jira-task-creator` | Ticket creation with template validation |
| `jira-transitioner` | Verify merged PRs, transition tickets to Done |

## Auto-Dispatch

| /work Step | Agent(s) |
|---|---|
| brief | brief-writer |
| spec | spec-writer |
| implement | developer-* (by file type) |
| commit | commit-writer |
| check | code-checker, quality-checker, qa-*, completion-checker |
| pr | pr-generator, pr-post-generator |

## Authorization

Scripts gated to specific agents:

| Script | Agents |
|---|---|
| `tdd-phase-state.js` | developer-* |
| `write-qa-report.js` | qa-feature-tester, qa-api-tester |
| `write-tests-report.js` | quality-checker |
| `write-code-review.js` | code-checker |
| `write-completion-report.js` | completion-checker |

## TDD RED rejection: test-load failures (GH-532)

`record-red` (in `tdd-phase-state.js`) rejects test runs whose output contains
a top-level load-failure signature instead of an assertion failure:

- `ReferenceError:` outside `assert.throws`
- `SyntaxError:` from the test file or its imports
- `Cannot find module` / `MODULE_NOT_FOUND`
- Runner reports zero tests executed (`# tests 0`, anchored to the TAP summary line)

These crashes exit non-zero but verify nothing — accepting them as RED wedges
the subsequent GREEN phase (same crash repeats regardless of source edits).
Stack-frame lines (`  at …`) and lines inside a reported test's `details:`
block are ignored, so `assert.throws(ReferenceError)` remains a valid RED.

**Recovery (this is NOT a bypass, NOT a behavior gap):** fix the test file so
it loads cleanly and produces a real assertion failure, then re-run
`tdd-phase-state.js record-red`. Each rejection appends a
`tdd-red-load-failure-rejected` row to `.work-actions.json` via
`appendEnforcementAudit` (action: `tdd-red-load-failure-rejected`,
`allow: false`, `meta: { cycle, testCommand, signature, snippet }`).

# Claude Plugin Work

## Project Overview

This is a Claude Code plugin (Node.js, CommonJS only). It provides deterministic workflows for ticket-to-PR delivery via `/work`, `/check`, `/work-implement`, and `/work-pr` commands.

See **[AGENTS.md](./AGENTS.md)** for the agent catalog. See **[docs/README.md](./docs/README.md)** for full architecture documentation.

## Development Rules

### Language & Runtime
- **CommonJS only** — `require`/`module.exports`. No ES modules, no `.mjs`, no bundlers.
- **Plain JavaScript** — No TypeScript. No transpilation. Runs directly under Node.js.
- **Node built-in test runner** — `node:test` + `node:assert/strict`. No Jest, Vitest, or Mocha.
- **Zero runtime dependencies** — Only `@biomejs/biome` as devDependency for formatting.

### Testing
- Run tests: `pnpm test`
- Run specific test: `node --test scripts/workflows/work/__tests__/transition-step.test.js`
- Tests spawn hook scripts with `child_process.spawn` to test exit codes — this is the established pattern.
- Temp directories use `fs.mkdtempSync` + `rmSync({ recursive: true, force: true })` in `after`/`afterEach`.

### Code Conventions
- `process.exit(0/1/2)` in hooks is intentional — 0=allow, 2=block.
- Fail-open: hooks `catch` errors and exit 0 (allow). Only intentional blocks use exit 2.
- `logHookError(__filename, err)` is the logging convention. Not `console.error`.
- `Object.create(null)` prevents prototype pollution — intentional.
- Config via `scripts/workflows/lib/config.js` — never duplicate its logic elsewhere.
- `getConfig('TASKS_BASE')` / `getConfig.orExit(...)` are the canonical config accessors.

### File Organization
- `scripts/workflows/` — Core engine, per-workflow definitions, hooks, scripts
- `scripts/workflows/lib/` — Shared utilities (config, enforcement, validation, policies)
- `scripts/workflows/lib/hooks/policies/` — Pure decision functions (testable, no side effects)
- `agents/` — Agent definitions (markdown instruction files)
- `skills/` — Slash command definitions (SKILL.md per command)
- `hooks/hooks.json` — Hook registration (matchers, commands, timeouts)

### State Machine
- 18 steps: `ticket → bootstrap → brief → brief_gate → spec → spec_gate → tasks → implement → commit → task_review → check → pr → ready → follow_up → ci → cleanup → reports → complete`
- Step IDs are in `scripts/workflows/work/step-registry.js` — decoupled from ordering.
- Transitions validated by `workflowCanTransition()` — only declared edges are allowed.
- `transition-step.js` handles state persistence, artifact archival, and TDD gates.

### TDD Enforcement
- `implement` step is TDD-gated: must record RED → GREEN cycle before transitioning out.
- `tdd-phase-state.js` is the ONLY way to record evidence — agents cannot self-report.
- Phase gating hook (`work-implement-enforce.js`) blocks file edits by phase:
  - RED: only `.test.*`/`.spec.*` files
  - GREEN: only source files + test helpers
  - REFACTOR: all files
- `exception` mode for config-only changes — overwrites state directly, not via transition graph.

### Security
- All ticket-ID-to-path conversions validated against directory traversal.
- `protect-state-files.js` guards `.work-state.json` etc. from direct edits.
- `protect-artifact-files.js` enforces step+agent authorization for report files.
- Agent-gated scripts require both correct agent identity AND correct workflow step.

### Ticket Providers
- Configured via `TICKET_PROVIDER` env var: `jira`, `linear`, `github`, `none`.
- GitHub issues use `#N` IDs, sanitized to `GH-N` for filesystem paths.
- `ticket-provider.js` handles all provider-specific logic.

### Formatting
- `pnpm format` — biome formatter
- `pnpm format:check` — check only

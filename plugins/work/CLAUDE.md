# Claude Plugin Work

## Project Overview

This is a Claude Code plugin (Node.js, CommonJS only). It provides deterministic workflows for ticket-to-PR delivery via `/work`, `/check`, `/work-implement`, and `/work-pr` commands.

See **[AGENTS.md](./AGENTS.md)** for the agent catalog. See **[docs/README.md](./docs/README.md)** for full architecture documentation.

### Codex ↔ Claude Code

This plugin family runs on **both Claude Code and Codex CLI**. The full migration
map — plugins, skills, subagents, hooks, MCP, permissions, slash commands,
statusline, env vars, and marketplace — lives in
**[docs/codex-support/05-codex-claude-plugin-map.md](../../docs/codex-support/05-codex-claude-plugin-map.md)**,
alongside the machine-verified series in [`docs/codex-support/`](../../docs/codex-support/)
(ground truth → touchpoint inventory → adapter design → work breakdown).

Load-bearing facts when porting:
- Manifest dir `.claude-plugin/` ↔ `.codex-plugin/`; `CLAUDE.md` ↔ `AGENTS.md`.
- Env vars `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` ↔ `PLUGIN_ROOT`/`PLUGIN_DATA` (Codex sets both — write `PLUGIN_ROOT:-CLAUDE_PLUGIN_ROOT` fallbacks).
- Codex degradations announce a greppable `[<plugin>:codex-degraded]` prefix (see [`03-adapter-design.md`](../../docs/codex-support/03-adapter-design.md) §0/§M).
- Codex `tui.status_line` is **built-in-fields-only** ([openai/codex#20140](https://github.com/openai/codex/issues/20140)), so command-backed status bars (the `/work` ⚙ bar, the 🔄 follow-up bar) can't render on codex — they degrade to a `/status` + `watch` fallback.

## Development Rules

### Language & Runtime
- **CommonJS only** — `require`/`module.exports`. No ES modules, no `.mjs`, no bundlers.
- **Plain JavaScript** — No TypeScript. No transpilation. Runs directly under Node.js.
- **Node built-in test runner** — `node:test` + `node:assert/strict`. No Jest, Vitest, or Mocha.
- **Zero runtime dependencies** — Runtime dependencies must stay zero (the plugin is installed by users; their install size matters). devDependencies for lint/build/format tooling are permitted: `@biomejs/biome` (format + cognitive-complexity), `eslint` (4 quality rules), `jscpd` (duplicate-block detection). These do not ship to consumers.

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
- `task-next.js` is the developer-agent entrypoint in multi-task mode
  (`task-next.js <TICKET> task<N>`): it resolves the runnable command from the
  task's `### Test Strategy` via the SHARED implement-gate resolver
  (`resolveTaskTestExecution`), runs it, validates phase rules (including the
  kind-aware contracts from `task-types.js`), and delegates recording to
  `tdd-phase-state.js`. Machine-verified escape paths: `--resume-completed`
  (GH-509, audited `tdd-resume-completed`) and planner-declared
  `red-mode: ablation` (GH-570, audited `tdd-ablation-cycle`).
- Phase gating hook (`work-implement-enforce.js`) is registered in `hooks/hooks.json`
  (PreToolUse, matcher `Edit|Write|MultiEdit`, after the protect-* hooks) and blocks
  file edits by phase:
  - RED: only `.test.*`/`.spec.*` files — except tasks whose planner-declared
    `### Test Strategy` carries `red-mode: ablation` (GH-570), which may edit
    source files INSIDE the task's `### Files in scope` (the temporary
    mutation); each such allow is audited (`ABLATION_RED_SOURCE_EDIT`)
  - GREEN: only source files + test helpers
  - REFACTOR: all files
  Fail-open when no workflow/implement step is active (exit 0).
- Stop gating hook (`enforce-tdd-on-stop.js`) is registered in `hooks/hooks.json`
  (SubagentStop, matcher `.*`) and self-filters (exit 0) unless the stopping
  subagent is POSITIVELY identified as a developer-* agent — via the payload's
  `agent_type` field (the documented SubagentStop identity field; legacy
  agent_name/subagent_type read as fallbacks) or, when absent, the structural
  developer dispatch-prompt marker in the subagent transcript's first user
  message ('self-paced TDD agent' + task-next.js). Unidentifiable subagents,
  undetectable tickets, non-implement steps, and checkpoint tasks are all
  allowed to stop. When a developer
  agent stops during `implement` without a valid TDD cycle, it blocks (exit 2) and
  prints the ONE next command (`task-next.js`) — it never runs tests or records
  evidence itself. Evidence is judged by the ONE shared contract-aware validator
  (`tdd-enforcement.js validateTddEvidenceForType` — the SAME function the
  implement gate and the check/complete validators use): TDD-exempt Types are
  satisfied by red-only/green-only evidence (e.g. the gate's non-TDD stub), and
  citation-kind GREEN evidence (`verified-by`/`wiring-citation` with `peerSha`)
  satisfies the hook. A task with
  no `### Test Strategy` resolution is allowed to stop, but the allow is audited to
  `.work-actions.json` (enforcement row, action `tdd-stop-strategy-missing-allow`).
- `exception` mode is OPERATOR-ONLY (requires `WORK_OPERATOR_TOKEN=1` — agent
  environments never carry it). It overwrites state directly, not via the
  transition graph. Categories are built from the shared TDD-exemption enum in
  `skills/split-in-tasks/lib/task-types.js` (`tests-only`, `docs`, `config`,
  `ci`, `mechanical-refactor`, `file-move`, `checkpoint`) plus the legacy
  alias `config-only` (= `config`); every use is audited to
  `.work-actions.json` (`tdd-exception`). Agents get TDD exemptions ONLY via
  the planner's `### Type` line, never by invoking `exception`.

### Security
- All ticket-ID-to-path conversions validated against directory traversal.
- `protect-state-files.js` guards `.work-state.json` etc. from direct edits.
- `protect-artifact-files.js` enforces step+agent authorization for report files.
- Agent-gated scripts require both correct agent identity AND correct workflow step.
- `protect-task-scope.js` blocks edits outside the active task's `### Files in scope`. The env-var escape hatch is ONE-SHOT and requires BOTH `PROTECT_TASK_SCOPE_BYPASS_REASON="<reason>"` AND `PROTECT_TASK_SCOPE_BYPASS_TARGET="<exact-rel-path-or-glob>"` to be set; the bypass only fires when the actual write target matches `BYPASS_TARGET` (exact or glob). REASON alone never opens the gate. Each fired bypass appends a `scope-bypass` row to `.work-actions.json` recording both the configured target and the actual write path.

### Feature Flags

(None currently. The `WORK_TEST_STRATEGY_VALIDATOR` flag was removed — the
GH-590 Test Strategy validators and the GH-610 implement-side synthesis
consumer are permanently on. Legacy `### Test Command` blocks are rejected
at the draft gate with a migration error pointing at
`skills/split-in-tasks/docs/test-strategy.md`.)

**Implement-side synthesis flow.** The implement side synthesizes the
runnable command from the task's `### Test Strategy` (the legacy
`### Test Command` readers were fully removed in GH-653). `readTaskTestCommand` /
`resolveTaskTestExecution` (`implement-gate.js`) call
`lib/test-strategy.js synthesizeCommand(strategy, findNearestEnvrc(worktreeDir))`
to produce the command for envelope kinds (`unit`/`integration`/`e2e`/`custom`),
threading the orchestrator's worktree-rooted `.envrc`. For citation kinds
(`verified-by`/`wiring-citation`) `synthesizeCommand` returns `null`; instead of
executing, `tdd-phase-state.js` records green evidence by peer citation
(`validatePeerCitation` + peer evidence sha + scope-overlap), and
`enforce-tdd-on-stop.js` accepts that citation evidence.

### Ticket Providers
- Configured via `TICKET_PROVIDER` env var: `jira`, `linear`, `github`, `none`.
- GitHub issues use `#N` IDs, sanitized to `GH-N` for filesystem paths.
- `ticket-provider.js` handles all provider-specific logic.

### Formatting
- `pnpm format` — biome formatter
- `pnpm format:check` — check only

### Static Code Quality Gate

A deterministic gate enforces six static-code rules across the repo. It is wired
into CI (`.github/workflows/ci.yml` → `quality` job) and is required for merge.

**Runner:** `scripts/workflows/lib/scripts/quality/quality.js`

**Local usage:**
- `pnpm quality` — full-repo scan; exits non-zero on any non-allowlisted violation
- `pnpm quality:changed` — scan only files changed against `main` (fast inner loop)

**Rules and default thresholds:**
| Rule ID | Threshold | What it catches |
|---|---|---|
| `max-lines` | 400 lines / file | Oversized modules |
| `max-lines-per-function` | 80 lines / function | Bloated functions |
| `cyclomatic-complexity` | 10 | Tangled branching (ESLint `complexity`) |
| `max-depth` | 4 | Deeply-nested blocks (ESLint `max-depth`) |
| `duplicate-blocks` | 50-token blocks across files | Copy-paste drift (jscpd) |
| `cognitive-complexity` | 15 / function | Cognitively complex functions (Biome `noExcessiveCognitiveComplexity`) |

The runner shells out to three tools and folds their diagnostics into a single
violation shape: ESLint owns the first four rules (`complexity`, `max-depth`,
`max-lines`, `max-lines-per-function` — config in
`scripts/workflows/lib/scripts/quality/configs/quality-lint-rules.js`), jscpd
owns `duplicate-blocks`, and `rules/biome-bridge.js` shells out to Biome for
`cognitive-complexity`.

**Allowlist (`.quality-exceptions` at repo root):**
- Captures the current set of pre-existing violations so the gate can flip on
  without a mass-refactor PR.
- **Burn-down policy: new PRs may only shrink, never grow, the allowlist.** Any
  PR that introduces a new entry is rejected by the gate; entries should be
  removed as code is cleaned up.
- File format: one relative path per line; blank lines and `#`-prefixed comments
  are ignored. Absolute paths and `..` traversal are rejected.

**When the gate fails:**
1. Read the runner output — each violation prints `file:line  rule (value) in function`.
2. Fix the violation (preferred) or, if the change is genuinely pre-existing
   and out of scope, leave it allowlisted and address in a follow-up.
3. Re-run `pnpm quality` locally before pushing.

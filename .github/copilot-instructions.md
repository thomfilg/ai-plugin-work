# Copilot Code Review Instructions

**Architecture Reference:** See [`docs/README.md`](../docs/README.md) for full codebase documentation — architecture, workflows, state machine, hooks, TDD enforcement, agents, skills, and configuration.

## Stale Comment Resolution

- Before flagging an issue, check if it was already fixed in a later commit in the same PR.
- If your previous comment was addressed by a subsequent push, resolve the thread — do not repeat it.
- Only comment on code that exists in the latest commit of the PR, not on removed or replaced lines.
- When re-reviewing after a push, focus on new/changed code, not previously reviewed lines.
- After force-pushes, you will re-review the entire PR and may re-post prior comments. The repo's `follow-up-pr.js` dedupes these by `(file_path, body)` content hash. Before re-flagging an issue after a force-push, verify it still exists in the **current** commit, not just in a previously-reviewed version.

## Comment Severity Classification

Every review comment MUST include a severity tag at the start of the comment body:

- `[critical]` — Security vulnerability, data loss, or breaking production. Must fix.
- `[high]` — Bug, incorrect logic, or missing error handling. Must fix.
- `[medium]` — Code quality or suboptimal pattern. Should fix.
- `[low]` — Minor improvement. Nice to have.
- `[nitpick]` — Stylistic/cosmetic. Can ignore.

**Default severity:** If you omit the tag, the review automation treats the comment as `[medium]` (blocking). Be intentional — tag stylistic or speculative feedback as `[nitpick]` or `[low]` so it does not block PR merges.

**Tag placement:** The tag must be the first token of the comment body. Tags inside quoted text or later in the body are ignored by the priority classifier. A comment that starts with a code fence, blockquote, or prose before the tag is treated as `[medium]`.

**One issue per comment.** Do not bundle multiple unrelated issues into a single comment. Each comment should cover one file/location and one severity level. Multi-issue comments inflate the priority of minor feedback.

## Review Scope

- Only review lines that were **modified** in this PR — do not review entire files that were added or moved.
- If a file was copied or moved from another location, focus only on the changes made during the move, not pre-existing code. Example: if `scripts/symlink.js` is moved to `external_scripts/symlink.js`, git shows the entire file as "added" — do not review the 400 lines of pre-existing logic, only comment on lines that were actually modified during the move.
- Do not flag issues in code that existed before this PR unless the PR explicitly changed that code.

## Review Focus

When reviewing pull requests in this repository:

1. Focus on correctness, security, and maintainability.
2. This is a Claude Code plugin (Node.js, no TypeScript) — hooks and scripts run as CLI processes.
3. Fail-open patterns in hooks are intentional — do not suggest fail-closed alternatives.
4. Exit codes `process.exit(0/1/2)` are intentional in hook scripts — do not suggest throwing errors instead.
5. `lib/config.js` is the centralized config module — do not suggest duplicating its logic elsewhere.
6. `getBaseBranch()` in `config.js` is reused by reference across hooks — this is intentional DRY.
7. `WEB_APPS` is loaded from the repo `.env` file — do not flag it as hardcoded.
8. This project uses **CommonJS only** (`require`/`module.exports`). Do not suggest ES modules (`import`/`export`), `.mjs`, or bundler configurations.
9. Tests use the built-in `node:test` runner with `node:assert/strict`. Do not suggest Jest, Vitest, Mocha, Chai, or other frameworks.
10. Do not suggest adding transpilation, bundlers, or build steps. The code runs directly under Node.

## Do NOT Flag

### Type system & documentation
- Missing TypeScript types — this project uses plain JavaScript intentionally.
- Missing JSDoc on every function — only flag genuinely unclear APIs.

### Intentional patterns
- `Object.create(null)` — used intentionally to prevent prototype pollution.
- `Set` instead of `Array` for deduplication — it is the correct choice.
- Shell command string interpolation when values come from git commands (not user input).
- Config values imported from `lib/config.js` — they are centralized by design.

### Hook conventions
- `logHookError(__filename, err)` in hooks — this is the repo's logging convention. Do not suggest `console.error` or throwing from hook handlers.
- Silent `catch { ... }` blocks that call `logHookError` or follow a documented fail-open pattern. Only flag empty catches that swallow errors **without** logging or fail-open handling.

### Security hardening
- Defensive patterns in `workflows/lib/protect-state-files.js` — the four-vector design (Edit/Write, Bash, script, inline-interpreter) is intentional. Do not suggest collapsing vectors or simplifying regex patterns without understanding the bypass they close.
- `fs.realpathSync` + `git ls-files` checks for trusted test scripts — this is the GH-191 hardening. Do not suggest replacing with simpler suffix-based checks.
- Base64 over-blocking in inline-interpreter detection — this is an intentional tradeoff documented in the GH-107 spec.

### Test conventions
- Test files using `const { describe, it } = require('node:test')` and `const assert = require('node:assert/strict')` — this is the project's standard.
- Tests that spawn hook scripts with `child_process.spawn` to test exit codes — this is the established hook-testing pattern (see `pr-review-validator.test.js`, `pr-generator-validator.test.js`). Do not suggest mocking or in-process execution.
- Temp directory creation with `fs.mkdtempSync(path.join(os.tmpdir(), '...'))` followed by `rmSync({ recursive: true, force: true })` in `after`/`afterEach` — this is the standard test-fixture lifecycle.

### Paths & worktrees
- `getConfig('TASKS_BASE')` / `getConfig('WORKTREES_BASE')` / `getConfig.orExit(...)` calls — these are the canonical config accessors. Do not suggest inlining `process.env` fallback logic.
- Path construction via `path.join(TASKS_BASE, safeTicketPath(ticketId), ...)` — do not suggest removing `safeTicketPath` sanitization.
- Git worktree detection via `git rev-parse --show-toplevel` — do not suggest `__dirname`-based root detection.

### Instruction / prompt files
- Content inside `skills/**/SKILL.md`, `agents/**.md`, or `workflows/**/agents/**.md` — these are instruction documents for AI agents. Code fences inside them are illustrative examples, not executable code. Do not flag "unused imports," "missing types," or "dead code" inside these fences.

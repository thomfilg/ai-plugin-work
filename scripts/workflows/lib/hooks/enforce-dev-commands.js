#!/usr/bin/env node

/**
 * PreToolUse Bash hook: Enforce dev-check scripts over raw pnpm commands.
 *
 * Intercepts raw pnpm lint/test/typecheck commands (including dev: variants)
 * and blocks them with a message pointing to the correct dev-check.sh script.
 *
 * Allowed: pnpm dev:check (the correct unified command).
 * Blocked: pnpm lint, pnpm run lint, pnpm test, pnpm run test,
 *          pnpm typecheck, pnpm run typecheck,
 *          pnpm dev:lint, pnpm dev:typecheck, pnpm dev:test
 */

const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', 'hook-error-log'));

// Fail-open: unexpected errors should never block unrelated commands
process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});
process.on('unhandledRejection', (err) => {
  logHookError(__filename, err);
  process.exit(0);
});

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..', '..');

/**
 * Detection strategy: search for pnpm + blocked script name anywhere in the
 * command text. Block ONLY when the script is invoked with NO arguments (i.e.
 * the bare command runs the entire suite). Scoped invocations like
 * `pnpm test path/to/file.test.ts` or `pnpm test -t 'pattern'` are allowed —
 * agents need to run targeted tests during development.
 */
const BLOCKED_SCRIPTS = ['lint', 'test', 'typecheck', 'dev:lint', 'dev:typecheck', 'dev:test'];

/**
 * Match the bare script name with NO trailing argument before a command
 * terminator. The lookahead `[\s"')\]},;|&]*` consumes only whitespace and
 * terminators — anything else means there's a following arg, so allow.
 *
 * Captures:
 *   pnpm test                  → blocked (no args)
 *   pnpm test &&               → blocked (no args before chain)
 *   pnpm run test              → blocked
 *   pnpm test path/foo.spec    → ALLOWED (has arg)
 *   pnpm test -t 'pattern'     → ALLOWED (has arg)
 *   pnpm test --filter=x       → ALLOWED (has arg)
 */
// After the script name we BLOCK only when followed by a hard terminator
// (end-of-string, ;, |, &, newline, or `)`) — meaning no trailing argument.
// We deliberately do NOT treat `"` or `'` as terminators because they often
// appear inside content (grep patterns, comments, error messages) and would
// cause false positives. Trade-off: `bash -lc "pnpm lint"` is no longer blocked.
const BLOCKED_PATTERNS = BLOCKED_SCRIPTS.map(
  (script) =>
    new RegExp(
      `(?:^|[^\\w])pnpm\\s+(?:[^&;|\\n]*?\\s)?(?:run\\s+(?:[^&;|\\n]*?\\s)?)?${script.replace(':', '\\:')}\\s*(?=$|[;|&\\n)])`
    )
);

/**
 * Defense-in-depth: pnpm dev:check is the correct command and must never
 * be blocked, even if a future BLOCKED_PATTERNS entry accidentally matches it.
 */
const ALLOWED_PATTERN = /(?:^|[^\w])pnpm\s+(?:run\s+)?dev:check(?=[\s"')\]},;|&]|$)/;

function isBlocked(command) {
  if (ALLOWED_PATTERN.test(command)) {
    // dev:check present — strip it then re-check (so it doesn't shadow a
    // sibling blocked command in a chain).
    const withoutAllowed = command.replace(
      /(?:^|[^\w])pnpm\s+(?:run\s+)?dev:check(?=[\s"')\]},;|&]|$)/,
      ' '
    );
    return BLOCKED_PATTERNS.some((p) => p.test(withoutAllowed));
  }
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  const hookData = JSON.parse(input);
  const command = hookData?.tool_input?.command || '';

  if (!command || !isBlocked(command)) {
    process.exit(0);
  }

  const scriptPath = path.join(
    PLUGIN_ROOT,
    'workflows',
    'lib',
    'scripts',
    'dev-check',
    'dev-check.sh'
  );
  const message = [
    'BLOCKED: Bare pnpm lint/test/typecheck (no args) runs the whole suite.',
    '',
    'Either:',
    `  - Run scoped: pnpm test <file-or-pattern>  (e.g. pnpm test path/foo.spec.ts)`,
    `  - Or use the unified dev-check script: ${scriptPath}`,
    '',
    'dev-check.sh runs lint → typecheck → test on changed files only.',
    '',
  ].join('\n');

  process.stderr.write(message);
  process.exit(2);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0);
});

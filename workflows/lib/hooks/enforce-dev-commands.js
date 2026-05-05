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
 * command text. This catches all wrapper forms (env, command, time, bash -c,
 * subshells, command substitution, etc.) without needing to enumerate them.
 *
 * We use non-anchored patterns with \b word boundaries to find pnpm invocations
 * regardless of what precedes them. The (?:run\s+)? handles `pnpm run <script>`.
 * Flags between pnpm/run and the script are tolerated via a permissive middle.
 */
const BLOCKED_SCRIPTS = ['lint', 'test', 'typecheck', 'dev:lint', 'dev:typecheck', 'dev:test'];

const BLOCKED_PATTERNS = BLOCKED_SCRIPTS.map(
  (script) =>
    new RegExp(
      `(?:^|[^\\w])pnpm\\s+(?:[^&;|\\n]*?\\s)?(?:run\\s+(?:[^&;|\\n]*?\\s)?)?${script.replace(':', '\\:')}(?=[\\s"')\\]},;|&]|$)`
    )
);

/**
 * Defense-in-depth: pnpm dev:check is the correct command and must never
 * be blocked, even if a future BLOCKED_PATTERNS entry accidentally matches it.
 */
const ALLOWED_PATTERN =
  /(?:^|[^\w])pnpm\s+(?:.*?\s)?(?:run\s+(?:.*?\s)?)?dev:check(?=[\s"')\]},;|&]|$)/;

function isBlocked(command) {
  // Check the full command text — no splitting needed since patterns are non-anchored.
  // But we still need to ensure that if dev:check is present alongside a blocked command
  // in a chain, only the blocked part triggers.
  const hasBlocked = BLOCKED_PATTERNS.some((p) => p.test(command));
  if (!hasBlocked) return false;

  // If the command also contains dev:check, check if the blocked match is
  // from a different part of the command (not the dev:check itself).
  // dev:test/dev:lint/dev:typecheck are blocked; dev:check is allowed.
  if (ALLOWED_PATTERN.test(command)) {
    // Remove only the dev:check segment (don't cross command separators)
    const withoutAllowed = command.replace(
      /(?:^|[^\\w])pnpm\s+(?:[^&;|\n]*?\s)?(?:run\s+(?:[^&;|\n]*?\s)?)?dev:check(?=[\s"')\]},;|&]|$)/,
      ' '
    );
    return BLOCKED_PATTERNS.some((p) => p.test(withoutAllowed));
  }

  return true;
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
    'BLOCKED: Raw pnpm lint/test/typecheck commands are not allowed.',
    '',
    'Use the unified dev-check script instead:',
    `  ${scriptPath}`,
    '',
    'This script runs lint → typecheck → test on changed files only (faster, consistent).',
    '',
  ].join('\n');

  process.stderr.write(message);
  process.exit(2);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0);
});

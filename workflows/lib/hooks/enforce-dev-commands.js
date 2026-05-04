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
 * Patterns that match intercepted pnpm commands.
 * Each regex matches the command as a standalone invocation or after && / ; / |
 * but NOT as a substring of another word (e.g. "echo linting" should not match).
 */
const BLOCKED_PATTERNS = [
  // pnpm lint / pnpm run lint
  /(?:^|&&|;|\|)\s*pnpm\s+(?:run\s+)?lint(?:\s|$)/,
  // pnpm test / pnpm run test
  /(?:^|&&|;|\|)\s*pnpm\s+(?:run\s+)?test(?:\s|$)/,
  // pnpm typecheck / pnpm run typecheck
  /(?:^|&&|;|\|)\s*pnpm\s+(?:run\s+)?typecheck(?:\s|$)/,
  // pnpm dev:lint
  /(?:^|&&|;|\|)\s*pnpm\s+(?:run\s+)?dev:lint(?:\s|$)/,
  // pnpm dev:typecheck
  /(?:^|&&|;|\|)\s*pnpm\s+(?:run\s+)?dev:typecheck(?:\s|$)/,
  // pnpm dev:test
  /(?:^|&&|;|\|)\s*pnpm\s+(?:run\s+)?dev:test(?:\s|$)/,
];

/** Commands that are explicitly allowed (not blocked even if they match patterns) */
const ALLOWED_PATTERNS = [
  // pnpm dev:check is the correct command
  /(?:^|&&|;|\|)\s*pnpm\s+(?:run\s+)?dev:check(?:\s|$)/,
];

function isBlocked(command) {
  // Split on chain operators and check each segment independently.
  // A command is blocked if ANY segment matches a blocked pattern
  // and that same segment is not covered by the allow-list.
  const segments = command.split(/\s*(?:&&|;|\|)\s*/);
  for (const segment of segments) {
    const segBlocked = BLOCKED_PATTERNS.some((p) => p.test(segment));
    if (!segBlocked) continue;
    const segAllowed = ALLOWED_PATTERNS.some((p) => p.test(segment));
    if (!segAllowed) return true;
  }
  return false;
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

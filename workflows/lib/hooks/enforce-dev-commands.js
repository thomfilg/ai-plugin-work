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
 * Each regex is tested against individual segments after splitting on separators
 * (&&, ;, |, \n), so they only need to match from the start of a segment.
 */
/**
 * Prefix pattern that tolerates:
 * - Environment variable assignments: CI=1 pnpm ..., env FOO=1 pnpm ...
 * - pnpm flags before the script name: --filter pkg, -r, --workspace-root, etc.
 *
 * Structure: ^<optional env prefixes><pnpm><optional flags><script>
 */
const ENV_PREFIX = '(?:\\w+=\\S+\\s+)*(?:env\\s+(?:\\w+=\\S+\\s+)*)?';
const PNPM_FLAGS = '(?:(?:-[-\\w]+(?:[=\\s]\\S+)?)\\s+)*';

const BLOCKED_PATTERNS = [
  // pnpm lint / pnpm run lint (with optional env prefixes and pnpm flags)
  new RegExp(`^\\s*${ENV_PREFIX}pnpm\\s+${PNPM_FLAGS}(?:run\\s+)?lint(?:\\s|$)`),
  // pnpm test / pnpm run test
  new RegExp(`^\\s*${ENV_PREFIX}pnpm\\s+${PNPM_FLAGS}(?:run\\s+)?test(?:\\s|$)`),
  // pnpm typecheck / pnpm run typecheck
  new RegExp(`^\\s*${ENV_PREFIX}pnpm\\s+${PNPM_FLAGS}(?:run\\s+)?typecheck(?:\\s|$)`),
  // pnpm dev:lint
  new RegExp(`^\\s*${ENV_PREFIX}pnpm\\s+${PNPM_FLAGS}(?:run\\s+)?dev:lint(?:\\s|$)`),
  // pnpm dev:typecheck
  new RegExp(`^\\s*${ENV_PREFIX}pnpm\\s+${PNPM_FLAGS}(?:run\\s+)?dev:typecheck(?:\\s|$)`),
  // pnpm dev:test
  new RegExp(`^\\s*${ENV_PREFIX}pnpm\\s+${PNPM_FLAGS}(?:run\\s+)?dev:test(?:\\s|$)`),
];

/**
 * Defense-in-depth: commands explicitly allowed even if they partially match
 * a blocked pattern. This safety override ensures future BLOCKED_PATTERNS
 * additions cannot accidentally block legitimate commands.
 */
const ALLOWED_PATTERNS = [
  // pnpm dev:check is the correct command (with optional env prefixes and pnpm flags)
  new RegExp(`^\\s*${ENV_PREFIX}pnpm\\s+${PNPM_FLAGS}(?:run\\s+)?dev:check(?:\\s|$)`),
];

function isBlocked(command) {
  // Split on chain operators and check each segment independently.
  // A command is blocked if ANY segment matches a blocked pattern
  // and that same segment is not covered by the allow-list.
  const segments = command.split(/\s*(?:&&|;|\||\n)\s*/);
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

#!/usr/bin/env node

/**
 * validate-commit-msg.js — the git `commit-msg` hook wrapper (GH-539, Task 2).
 *
 * Git invokes this hook automatically on `git commit`, passing the path to the
 * draft commit-message file as `argv[2]`. The hook reads that draft, runs it
 * through the shared `commit-msg-rules.js` rule set (the single source of
 * truth), and enforces the commit contract with zero subagent dispatch:
 *
 *   - PASS  → exit 0 (git proceeds with the commit).
 *   - FAIL  → exit 1, writing `commit-msg validation failed: <rule>` and
 *             `↳ Hint: <hint>` to stderr so the author sees the specific rule
 *             and an actionable fix (git aborts the commit).
 *
 * Fail-safe semantics (spec §Security): a rule violation ALWAYS blocks. Only a
 * genuine infrastructure error — an unreadable / missing message file — fails
 * OPEN via `logHookError` + exit 0, so a transient I/O fault never wedges the
 * commit path. A parsed rule failure is NEVER swallowed by the fail-open branch.
 *
 * Zero runtime dependencies: only Node built-ins plus two in-repo modules.
 */

'use strict';

const fs = require('fs');
const { validateMessage } = require('./commit-msg-rules');
const { getProviderConfig } = require('../../lib/ticket-provider');
const { logHookError } = require('../../lib/hook-error-log');

/**
 * Render a rule failure into the two-line stderr block: the named rule followed
 * by an actionable hint.
 * @param {{rule: string, reason: string, hint: string}} result
 * @returns {string}
 */
function formatFailure(result) {
  const reason = result.reason ? ` (${result.reason})` : '';
  return `commit-msg validation failed: ${result.rule}${reason}\n↳ Hint: ${result.hint}\n`;
}

/**
 * Read the draft commit message from `argv[2]`. Throws on any I/O fault so the
 * caller can treat it as an infrastructure error and fail open.
 * @returns {string}
 */
function readDraftMessage() {
  return fs.readFileSync(process.argv[2], 'utf8');
}

/**
 * Hook entry point. Reads the draft, validates it, and exits 0/1 per the
 * commit contract. Infrastructure errors fail open (exit 0); rule violations
 * always block (exit 1).
 */
function main() {
  let message;
  try {
    message = readDraftMessage();
  } catch (err) {
    // Infrastructure error ONLY (unreadable/missing file): fail open.
    logHookError(__filename, err);
    process.exit(0);
    return;
  }

  const providerConfig = getProviderConfig({ skipPrompt: true });
  const result = validateMessage(message, { providerConfig });
  if (result.ok) {
    process.exit(0);
    return;
  }

  process.stderr.write(formatFailure(result));
  process.exit(1);
}

// Only run when invoked directly as the git hook; stay importable for tests.
if (require.main === module) {
  main();
}

module.exports = { formatFailure };

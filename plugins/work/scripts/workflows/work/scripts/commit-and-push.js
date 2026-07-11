#!/usr/bin/env node

'use strict';

/**
 * commit-and-push.js — the ONE sanctioned path for an agent to create a commit
 * (GH-539). The `enforce-agent-usage` PreToolUse hook BLOCKS a raw commit and
 * forces every agent through this script, so no agent has the option to bypass
 * the commit contract.
 *
 * The session agent authors the message; this script is the guard that:
 *   1. validates it against the shared rules (`commit-msg-rules.js`) — semantic
 *      format, no AI attribution, ticket ID, <=72 title, imperative mood, ...;
 *   2. rejects an AI git identity (claude/codex/gemini/...) via `git-identity.js`;
 *   3. stages everything, commits under the human identity, and pushes.
 *
 * Usage:
 *   node commit-and-push.js -m "feat(scope): add thing (#123)"
 *   node commit-and-push.js -F <message-file>
 *   node commit-and-push.js "feat(scope): add thing (#123)"   (positional)
 * Flags: --cwd <dir> (default cwd), --no-push (commit only).
 *
 * Exit codes: 0 success | 1 usage/validation/identity failure | 2 git failure.
 * Zero runtime dependencies: Node built-ins + in-repo modules only.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const { validateMessage } = require('../hooks/commit-msg-rules');
const { getProviderConfig } = require('../../lib/ticket-provider');
const { resolveGitUser, isAiIdentity } = require('../../lib/git-identity');

const USAGE = 'usage: commit-and-push.js -m "<semantic message>" [--cwd <dir>] [--no-push]';

/** Read a `-F` message file. Throws a usage error when the path is unreadable. */
function readFileArg(file) {
  if (!file) throw new Error(USAGE);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Apply the argv token at `i` to `opts`, returning the (possibly advanced) index
 * so flags that consume a value skip it on the next iteration.
 */
function applyArg(argv, i, opts) {
  const arg = argv[i];
  if (arg === '-m' || arg === '--message') opts.message = argv[++i];
  else if (arg === '-F' || arg === '--file') opts.message = readFileArg(argv[++i]);
  else if (arg === '--cwd') opts.cwd = argv[++i];
  else if (arg === '--no-push') opts.push = false;
  else if (opts.message === null && !arg.startsWith('-')) opts.message = arg;
  return i;
}

/** Parse argv into `{ message, cwd, push }`. Throws a usage error on bad input. */
function parseArgs(argv) {
  const opts = { message: null, cwd: process.cwd(), push: true };
  for (let i = 0; i < argv.length; i++) {
    i = applyArg(argv, i, opts);
  }
  if (!opts.message || !opts.message.trim()) throw new Error(USAGE);
  return opts;
}

/** Render a rule-validation failure into the two-line stderr block. */
function formatValidationFailure(result) {
  const reason = result.reason ? ` (${result.reason})` : '';
  return `commit rejected: ${result.rule}${reason}\n↳ Hint: ${result.hint}\n`;
}

/** Render the AI-identity rejection. */
function formatIdentityFailure(user) {
  return (
    `commit rejected: git ${user.source} identity "${user.name} <${user.email}>" looks like an AI tool\n` +
    `↳ Hint: commit under a real human user — set git user.name/user.email ` +
    `(claude/codex/gemini/etc. are rejected).\n`
  );
}

/**
 * Validate the message + committer identity. Returns an actionable error string
 * to print, or `null` when both pass.
 */
function validate(message, cwd) {
  const providerConfig = getProviderConfig({ skipPrompt: true });
  const result = validateMessage(message, { providerConfig });
  if (!result.ok) return formatValidationFailure(result);
  const user = resolveGitUser(cwd);
  if (isAiIdentity(user)) return formatIdentityFailure(user);
  return null;
}

/** Run a git subcommand in `cwd`, inheriting stdio. Throws on non-zero exit. */
function git(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'inherit' });
}

/** Stage everything, commit the message, and (unless disabled) push. */
function commitAndPush({ message, cwd, push }) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-m', message]);
  // `-u origin HEAD` publishes the branch under its own name and sets
  // tracking. A bare `git push` dies in fresh /bootstrap worktrees, whose
  // branch is created tracking origin/<base> (GH-697); this form is
  // idempotent for branches already tracking their same-name remote branch.
  if (push) git(cwd, ['push', '-u', 'origin', 'HEAD']);
}

/** CLI entry point. */
function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
    return;
  }

  const failure = validate(opts.message, opts.cwd);
  if (failure) {
    process.stderr.write(failure);
    process.exit(1);
    return;
  }

  try {
    commitAndPush(opts);
  } catch {
    // git already wrote its own diagnostics to the inherited stderr.
    process.exit(2);
    return;
  }
  process.stdout.write(
    `✅ committed${opts.push ? ' and pushed' : ''}: ${opts.message.split('\n')[0]}\n`
  );
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, validate, formatValidationFailure, formatIdentityFailure };

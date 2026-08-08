#!/usr/bin/env node
'use strict';

/**
 * install-commit-msg-hook — extend the guard past Claude Code.
 *
 * The PreToolUse hook covers commits an agent makes through the Bash tool.
 * A git `commit-msg` hook covers the rest: a terminal outside the session, a
 * script, an editor's git integration. Same rules, same module, one more
 * enforcement point.
 *
 * Opt-in on purpose — this writes into the repository's hooks directory, so it
 * only ever happens when someone asks for it.
 *
 * Usage:
 *   install-commit-msg-hook.js [--repo <dir>] [--force]   install
 *   install-commit-msg-hook.js --status [--repo <dir>]    report what is installed
 *   install-commit-msg-hook.js --uninstall [--repo <dir>] remove ours
 *
 * Exit codes: 0 done, 1 refused (a foreign hook is in the way), 2 usage error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const MARKER = '# ghostwriter-commit-msg v1';
const CHECKER = path.resolve(__dirname, 'ghostwriter-check.js');

function hookBody() {
  return [
    '#!/usr/bin/env sh',
    MARKER,
    '# Installed by ghostwriter. Rejects commit messages that credit an AI tool.',
    '# Remove with: node "$0.uninstall" — or run the plugin\'s',
    '# install-commit-msg-hook.js --uninstall.',
    `exec node ${JSON.stringify(CHECKER)} "$1"`,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { mode: 'install', repo: process.cwd(), force: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--force') args.force = true;
    else if (token === '--status') args.mode = 'status';
    else if (token === '--uninstall') args.mode = 'uninstall';
    else if (token === '--repo') {
      if (argv[i + 1] === undefined) return { error: '--repo needs a directory' };
      args.repo = argv[++i];
    } else return { error: `unknown option ${token}` };
  }
  return args;
}

/** The hooks directory git will actually consult (honours core.hooksPath). */
function resolveHooksDir(repo) {
  const raw = execFileSync(
    'git',
    ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
    {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  ).trim();
  return path.resolve(repo, raw);
}

function readHook(hookPath) {
  try {
    return fs.readFileSync(hookPath, 'utf8');
  } catch {
    return null;
  }
}

function statusOf(hookPath) {
  const existing = readHook(hookPath);
  if (existing === null) return 'absent';
  return existing.includes(MARKER) ? 'ours' : 'foreign';
}

function install(hookPath, force) {
  const status = statusOf(hookPath);
  if (status === 'foreign' && !force) {
    process.stderr.write(
      `ghostwriter: ${hookPath} already exists and was not written by ghostwriter.\n` +
        'Re-run with --force to replace it, or chain the check from your own hook:\n' +
        `  node ${CHECKER} "$1" || exit 1\n`
    );
    return EXIT_REFUSED;
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, hookBody(), { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  process.stdout.write(`ghostwriter: commit-msg hook installed at ${hookPath}\n`);
  return EXIT_OK;
}

function uninstall(hookPath) {
  const status = statusOf(hookPath);
  if (status === 'absent') {
    process.stdout.write('ghostwriter: no commit-msg hook to remove\n');
    return EXIT_OK;
  }
  if (status === 'foreign') {
    process.stderr.write(`ghostwriter: ${hookPath} is not ours — leaving it alone\n`);
    return EXIT_REFUSED;
  }
  fs.rmSync(hookPath);
  process.stdout.write(`ghostwriter: removed ${hookPath}\n`);
  return EXIT_OK;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`install-commit-msg-hook: ${args.error}\n`);
    return EXIT_USAGE;
  }
  let hookPath;
  try {
    hookPath = path.join(resolveHooksDir(args.repo), 'commit-msg');
  } catch {
    process.stderr.write(`install-commit-msg-hook: ${args.repo} is not a git repository\n`);
    return EXIT_USAGE;
  }
  if (args.mode === 'status') {
    process.stdout.write(`ghostwriter: commit-msg hook is ${statusOf(hookPath)} (${hookPath})\n`);
    return EXIT_OK;
  }
  return args.mode === 'uninstall' ? uninstall(hookPath) : install(hookPath, args.force);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, statusOf, MARKER };

#!/usr/bin/env node
'use strict';

/**
 * install-git-hooks — extend the guard past the agent's tools.
 *
 * The PreToolUse hooks cover what an agent does through Bash, a forge MCP call
 * and its write tools. Git hooks cover the rest: a terminal outside the
 * session, a script, an editor's git integration, a second agent. Same rules,
 * same modules, two more enforcement points:
 *
 *   commit-msg   the final message, AFTER the shell has expanded it — the one
 *                thing static inspection of a command can never see
 *   pre-commit   what the commit ADDS to the files, whoever wrote the lines
 *
 * Opt-in on purpose — this writes into the repository's hooks directory, so it
 * only ever happens when someone asks for it.
 *
 * Usage:
 *   install-git-hooks.js [--repo <dir>] [--force]   install both
 *   install-git-hooks.js --status [--repo <dir>]    report what is installed
 *   install-git-hooks.js --uninstall [--repo <dir>] remove ours
 *
 * Exit codes: 0 done, 1 refused (a foreign hook is in the way), 2 usage error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const { COMMIT_MSG_MARKER } = require(path.join(__dirname, '..', 'lib', 'policy'));
const CHECKER = path.resolve(__dirname, 'ghostwriter-check.js');
const SCANNER = path.resolve(__dirname, 'ghostwriter-scan.js');

/**
 * The hooks installed, each with the marker that identifies it as ours.
 *
 * `commit-msg` carries the shared marker because the guard reads it too: a
 * `--no-verify` matters when THAT hook is what is being skipped.
 */
const HOOKS = Object.freeze({
  'commit-msg': {
    marker: COMMIT_MSG_MARKER,
    summary: 'Rejects commit messages that credit an AI tool.',
    // "$1" is the message file git hands the hook — the final text, expanded.
    run: `exec node ${JSON.stringify(CHECKER)} "$1"`,
  },
  'pre-commit': {
    marker: '# ghostwriter-pre-commit v1',
    summary: 'Rejects staged changes that add AI attribution to a file.',
    run: `exec node ${JSON.stringify(SCANNER)} --staged`,
  },
});

function hookBody(name) {
  const hook = HOOKS[name];
  return [
    '#!/usr/bin/env sh',
    hook.marker,
    `# Installed by ghostwriter. ${hook.summary}`,
    "# Remove with the plugin's install-git-hooks.js --uninstall.",
    hook.run,
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

function statusOf(hookPath, name) {
  const existing = readHook(hookPath);
  if (existing === null) return 'absent';
  return existing.includes(HOOKS[name].marker) ? 'ours' : 'foreign';
}

/**
 * Write one hook, refusing to clobber somebody else's.
 *
 * A foreign hook is a decision the repository already made, and silently
 * replacing it is how a guard earns its reputation. The message says how to
 * chain ours from theirs, which keeps both.
 */
function installOne(hookPath, name, force) {
  const status = statusOf(hookPath, name);
  if (status === 'foreign' && !force) {
    process.stderr.write(
      `ghostwriter: ${hookPath} already exists and was not written by ghostwriter.\n` +
        'Re-run with --force to replace it, or chain the check from your own hook:\n' +
        `  ${HOOKS[name].run.replace('exec ', '')} || exit 1\n`
    );
    return EXIT_REFUSED;
  }
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, hookBody(name), { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  process.stdout.write(`ghostwriter: ${name} hook installed at ${hookPath}\n`);
  return EXIT_OK;
}

function uninstallOne(hookPath, name) {
  const status = statusOf(hookPath, name);
  if (status === 'absent') {
    process.stdout.write(`ghostwriter: no ${name} hook to remove\n`);
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

/** Run one action over both hooks, reporting the worst outcome. */
function forEachHook(hooksDir, action) {
  let worst = EXIT_OK;
  for (const name of Object.keys(HOOKS)) {
    const code = action(path.join(hooksDir, name), name);
    if (code > worst) worst = code;
  }
  return worst;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`install-git-hooks: ${args.error}\n`);
    return EXIT_USAGE;
  }
  let hooksDir;
  try {
    hooksDir = resolveHooksDir(args.repo);
  } catch {
    process.stderr.write(`install-git-hooks: ${args.repo} is not a git repository\n`);
    return EXIT_USAGE;
  }
  if (args.mode === 'status') {
    return forEachHook(hooksDir, (hookPath, name) => {
      process.stdout.write(
        `ghostwriter: ${name} hook is ${statusOf(hookPath, name)} (${hookPath})\n`
      );
      return EXIT_OK;
    });
  }
  if (args.mode === 'uninstall') return forEachHook(hooksDir, uninstallOne);
  return forEachHook(hooksDir, (hookPath, name) => installOne(hookPath, name, args.force));
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, statusOf, HOOKS };

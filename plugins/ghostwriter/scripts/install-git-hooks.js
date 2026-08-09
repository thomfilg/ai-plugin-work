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
function refuseForeign(hookPath, name) {
  process.stderr.write(
    `ghostwriter: ${hookPath} already exists and was not written by ghostwriter.\n` +
      'Re-run with --force to replace it, or chain the check from your own hook:\n' +
      `  ${HOOKS[name].run.replace('exec ', '')} || exit 1\n`
  );
  return EXIT_REFUSED;
}

/**
 * Every destination that would be refused, checked BEFORE anything is written.
 *
 * "Install both hooks" has to be one operation with one outcome. Installing
 * the first and then refusing the second reports failure while leaving a new
 * hook running — an operator who reads the exit code and tries something else
 * is now in a state nobody chose. Refusing before the first write leaves the
 * repository exactly as it was found.
 */
function refusals(hooksDir, force) {
  if (force) return [];
  return Object.keys(HOOKS).filter(
    (name) => statusOf(path.join(hooksDir, name), name) === 'foreign'
  );
}

function writeHook(hookPath, name) {
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, hookBody(name), { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  process.stdout.write(`ghostwriter: ${name} hook installed at ${hookPath}\n`);
}

/**
 * Install both hooks, or leave the repository as it was found.
 *
 * The preflight catches the expected refusal — somebody else's hook already
 * there — before anything is written. This catches the unexpected one: a full
 * disk, a read-only hooks directory, a permission that changed between the two
 * writes. Either way the outcome has to be both or neither, so anything
 * created before the failure is removed again. A hook that was ALREADY ours is
 * left alone: it was not created here, and deleting it would turn a failed
 * upgrade into a repository with no guard at all.
 */
function message(err) {
  return (err && err.message) || String(err);
}

/** Undo what this run created; report what it could not. */
function rollBack(created) {
  const stuck = [];
  for (const hookPath of created) {
    try {
      // `force` so a path that was claimed but never written is not reported
      // as stuck: nothing there is exactly the state rollback wants.
      fs.rmSync(hookPath, { force: true });
    } catch {
      stuck.push(hookPath);
    }
  }
  return stuck;
}

function installBoth(hooksDir) {
  const created = [];
  try {
    for (const name of Object.keys(HOOKS)) {
      const hookPath = path.join(hooksDir, name);
      // Recorded BEFORE the write, not after: `writeFileSync` can succeed and
      // the `chmod` that follows it fail, and a hook noted only on success is
      // a hook the rollback never hears about. Removal tolerates a file that
      // was never created, so claiming one costs nothing.
      if (!fs.existsSync(hookPath)) created.push(hookPath);
      writeHook(hookPath, name);
    }
  } catch (err) {
    const stuck = rollBack(created);
    process.stderr.write(`ghostwriter: could not install the hooks (${message(err)}).\n`);
    // Claiming a clean rollback that did not happen is worse than the failure
    // itself: it sends the operator away believing the repository is untouched
    // while a hook they never agreed to is running in it.
    if (stuck.length) {
      process.stderr.write(
        `ghostwriter: could NOT remove ${stuck.join(', ')} — a partial install remains.\n` +
          'Delete that file by hand, or re-run once the directory is writable.\n'
      );
    } else {
      process.stderr.write('Nothing was left behind — both hooks go in together.\n');
    }
    return EXIT_REFUSED;
  }
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
  const blocked = refusals(hooksDir, args.force);
  if (blocked.length) {
    for (const name of blocked) refuseForeign(path.join(hooksDir, name), name);
    process.stderr.write('ghostwriter: nothing was installed — both hooks go in together.\n');
    return EXIT_REFUSED;
  }
  return installBoth(hooksDir);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, statusOf, HOOKS };

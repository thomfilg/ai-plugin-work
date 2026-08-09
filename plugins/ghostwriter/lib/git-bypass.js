'use strict';

/**
 * git-bypass.js — the ways a command switches the backstop off.
 *
 * One hole in the PreToolUse layer is documented and cannot be closed by
 * parsing: a message that only exists after shell expansion (`-m "$FOOTER"`,
 * `-m "$(cat footer.txt)"`) is invisible until the shell runs, and evaluating
 * it would mean executing the command. The installed `commit-msg` hook is what
 * closes it, because git hands that hook the FINAL message.
 *
 * Which makes turning that hook off the way to reopen the hole. Git offers two
 * ways, both per-invocation, neither leaving a trace in the repository:
 *
 *   git commit --no-verify              skip the hooks for this commit
 *   git -c core.hooksPath=/dev/null …   point git at a directory with none
 *
 * Both are read here. Neither is treated as an offence on its own: skipping a
 * slow pre-commit lint is an ordinary thing to do, and a rule that punished it
 * would be a rule people learn to route around. The guard asks the narrower
 * question — is ghostwriter's own commit-msg hook installed in the repository
 * this command targets? — and only refuses when the answer is yes, because
 * only then is there a backstop being removed.
 */

const { longFlagValue } = require('./shell-tokenize');

/** Subcommands where `-n` is the short form of `--no-verify`. */
const SHORT_NO_VERIFY_SUBCOMMANDS = new Set(['commit', 'merge']);
const HOOKS_PATH_RE = /^core\.hookspath=/i;

/** `--no-verify`, or the `-n` that means it on this subcommand. */
function readNoVerify(argv, start, subcommand) {
  for (let i = start; i < argv.length; i++) {
    if (argv[i] === '--no-verify') return '--no-verify';
    if (argv[i] === '-n' && SHORT_NO_VERIFY_SUBCOMMANDS.has(subcommand)) return '-n';
  }
  return null;
}

/**
 * `-c core.hooksPath=…` and `--config-env=core.hooksPath=VAR`, which relocate
 * the hooks directory for this invocation only. The VALUE does not matter: any
 * relocation means the installed hook is not the one that will run.
 */
function readHooksPathOverride(argv, end) {
  for (let i = 0; i < end; i++) {
    if (argv[i] === '-c' && HOOKS_PATH_RE.test(argv[i + 1] || '')) return `-c ${argv[i + 1]}`;
    const spec = longFlagValue(argv, i, '--config-env');
    if (spec !== null && HOOKS_PATH_RE.test(spec)) return `--config-env ${spec}`;
  }
  return null;
}

/** `GIT_CONFIG_KEY_n=core.hooksPath` — the same override, through the env. */
function readHooksPathEnv(env) {
  const entry = env.find(
    (assignment) =>
      /^GIT_CONFIG_KEY_\d+$/.test(assignment.name) && HOOKS_PATH_RE.test(`${assignment.value}=`)
  );
  return entry ? `${entry.name}=${entry.value}` : null;
}

/**
 * How this command would keep the repository's hooks from running, or null.
 *
 * @param {string[]} argv - the segment's arguments, git binary at index 0.
 * @param {number} subcommandIndex - where the subcommand sits in `argv`.
 * @param {Array<{name: string, value: string}>} env - its own assignments.
 * @param {string} subcommand
 * @returns {string|null} the flag, quoted for the block message.
 */
function readHookBypass(argv, subcommandIndex, env, subcommand) {
  return (
    readNoVerify(argv, subcommandIndex + 1, subcommand) ||
    readHooksPathOverride(argv, subcommandIndex) ||
    readHooksPathEnv(env)
  );
}

module.exports = { readHookBypass, readNoVerify, readHooksPathOverride, readHooksPathEnv };

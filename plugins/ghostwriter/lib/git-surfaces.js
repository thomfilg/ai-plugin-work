'use strict';

/**
 * git-surfaces.js — pure analysis of a shell command: which parts of it write
 * git authorship, and what text would they write?
 *
 * Two narrow questions, answered on top of the quote-aware tokenizer:
 *
 *   1. Does this command author a git object (a commit, an annotated tag, a
 *      merge, a note) or set the identity such an object will carry?
 *   2. If so, which strings become the message, and which become the author?
 *
 * Precision buys precision downstream: `echo "git commit -m x"` is not a
 * commit, so it is never inspected, and `git config --get user.name` reads
 * rather than writes, so it never blocks. What the parser cannot see through —
 * a heredoc body, an unquoted `$(…)` — is still covered, because the guard
 * also scans the raw command text with the same attribution rules.
 *
 * WRAPPERS. A git command reached through `bash -c`, `env`, `sudo`, `xargs` or
 * a `-c` script payload is still a git command. Segments whose first word is a
 * known wrapper are peeled and re-classified (bounded by MAX_UNWRAP_DEPTH), so
 * `bash -c "git commit -m …"` is a surface exactly like the bare form.
 */

const { tokenize, longFlagValue } = require('./shell-tokenize');
const {
  identityEntry,
  parseAuthorSpec,
  readIdentities,
  readConfigIdentity,
} = require('./git-identity-args');

/** `git` global flags that consume the following token as their value. */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--config-env',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);

/** Subcommands whose invocation writes a message the caller authored. */
const MESSAGE_SUBCOMMANDS = new Set(['commit', 'tag', 'merge', 'notes']);

/** Subcommands that stamp a new object with the current committer identity. */
const IDENTITY_SUBCOMMANDS = new Set([
  'commit',
  'merge',
  'revert',
  'cherry-pick',
  'am',
  'tag',
  'notes',
]);

/**
 * Commands that run another command. The git invocation is either further
 * along the same argv (`env`, `sudo`, `timeout`, `xargs`) or inside a string
 * argument (`bash -c "…"`, `eval "…"`); both shapes are handled.
 */
const WRAPPER_BINARIES = new Set([
  'env',
  'command',
  'exec',
  'eval',
  'nice',
  'nohup',
  'sudo',
  'doas',
  'time',
  'timeout',
  'stdbuf',
  'xargs',
  'setsid',
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'busybox',
]);

/**
 * `git config` actions that READ or REMOVE. None of them can introduce an AI
 * identity, and `--get <name> <value-pattern>` in particular would otherwise
 * read as a write of the pattern.
 */
const CONFIG_READ_FLAGS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '--list',
  '-l',
  '--edit',
  '-e',
  '--unset',
  '--unset-all',
  '--remove-section',
  '--rename-section',
]);

const MAX_UNWRAP_DEPTH = 3;

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_BINARY_RE = /(?:^|\/)git$/;
/** A token that itself contains a git invocation — a `-c` script payload. */
const EMBEDDED_GIT_RE = /(?:^|[\s;&|(])git(?:\s|$)/;
/** `< file` / `<file` — git reads the message from there under `-F -`. */
const REDIRECT_RE = /^<(.*)$/;

/**
 * The two value-bearing flags read the same way: `--long value`, `--long=value`
 * or a combined short cluster such as `-am` / `-aF`.
 */
const MESSAGE_FLAG = { long: '--message', short: /^-[a-zA-Z]*m$/ };
const FILE_FLAG = { long: '--file', short: /^-[a-zA-Z]*F$/ };

function baseName(token) {
  const at = token.lastIndexOf('/');
  return at === -1 ? token : token.slice(at + 1);
}

function hasEmbeddedGit(token) {
  return EMBEDDED_GIT_RE.test(token);
}

/** Split leading `VAR=value` assignments off a segment's tokens. */
function splitEnvPrefix(tokens) {
  const env = [];
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i])) {
    const eq = tokens[i].indexOf('=');
    env.push({ name: tokens[i].slice(0, eq), value: tokens[i].slice(eq + 1) });
    i += 1;
  }
  return { env, argv: tokens.slice(i), prefix: tokens.slice(0, i) };
}

/**
 * Record the repository a command targets, as we skip git's global flags.
 *
 * `-C` moves the process directory; `--git-dir` points at the repository
 * whose config git will read. They are independent — `git --git-dir=X commit`
 * commits into X while still sitting in the shell's directory — so both are
 * kept, and the identity pass needs both to ask the right repository.
 * `--work-tree` selects the files, not the config, so it carries no identity.
 */
function captureTarget(argv, i, target) {
  const dir = longFlagValue(argv, i, '-C');
  if (dir !== null) target.dir = dir;
  const gitDir = longFlagValue(argv, i, '--git-dir');
  if (gitDir !== null) target.gitDir = gitDir;
}

/**
 * Locate the git subcommand in `argv`, skipping git's own global flags and
 * capturing the repository target. Repeated values compound in git; the last
 * one is kept, which is the common single-flag case.
 *
 * @returns {{subcommand: string, index: number, dir: string|null,
 *   gitDir: string|null}|null}
 */
function findSubcommand(argv) {
  if (!argv.length || !GIT_BINARY_RE.test(argv[0])) return null;
  const target = { dir: null, gitDir: null };
  let i = 1;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith('-')) return { subcommand: token, index: i, ...target };
    captureTarget(argv, i, target);
    i += GIT_GLOBAL_VALUE_FLAGS.has(token) ? 2 : 1;
  }
  return null;
}

/** `GIT_DIR=` reaches git the same way `--git-dir` does. */
function envGitDir(env) {
  const entry = env.find((assignment) => assignment.name === 'GIT_DIR');
  return entry ? entry.value : null;
}

/** Push the value of one value-bearing flag at `argv[i]` onto `target`. */
function collectFlagValue(argv, i, spec, target) {
  const long = longFlagValue(argv, i, spec.long);
  if (long !== null) {
    target.push(long);
    return;
  }
  if (spec.short.test(argv[i]) && i + 1 < argv.length) target.push(argv[i + 1]);
}

/**
 * A `< file` redirect feeds git's stdin, which is where `-F -` reads the
 * message from — so the redirect target is a message file like any other.
 */
function collectRedirect(argv, i, target) {
  const match = REDIRECT_RE.exec(argv[i]);
  if (!match) return;
  const file = match[1] || argv[i + 1];
  if (file && !file.startsWith('-')) target.push(file);
}

/** Collect `-m` / `--message` / `-F` / `--file` / `<` / `--author` from args. */
function readMessageArgs(argv, start, out) {
  for (let i = start; i < argv.length; i++) {
    collectFlagValue(argv, i, MESSAGE_FLAG, out.messages);
    collectFlagValue(argv, i, FILE_FLAG, out.messageFiles);
    collectRedirect(argv, i, out.messageFiles);
    const author = longFlagValue(argv, i, '--author');
    if (author !== null) out.identities.push({ source: '--author', ...parseAuthorSpec(author) });
  }
}

function newSurface(kind, writesMessage, writesCommit, target) {
  return {
    kind,
    writesMessage,
    writesCommit,
    dir: target.dir || null,
    gitDir: target.gitDir || null,
    messages: [],
    messageFiles: [],
    identities: [],
  };
}

/**
 * `git config` is a surface only when it WRITES `user.name` / `user.email`.
 * Read and remove actions author nothing, and `--get <name> <value-pattern>`
 * would otherwise read as a write of the pattern.
 */
function configSurface(argv, found) {
  if (argv.some((token) => CONFIG_READ_FLAGS.has(token))) return null;
  const surface = newSurface('config', false, false, found);
  readConfigIdentity(argv, found.index + 1, surface);
  return surface.identities.length ? surface : null;
}

/** commit / tag / merge / notes / revert / cherry-pick / am. */
function authoringSurface(argv, found, env) {
  const writesMessage = MESSAGE_SUBCOMMANDS.has(found.subcommand);
  const writesCommit = IDENTITY_SUBCOMMANDS.has(found.subcommand);
  if (!writesMessage && !writesCommit) return null;
  const target = { dir: found.dir, gitDir: found.gitDir || envGitDir(env) };
  const surface = newSurface(found.subcommand, writesMessage, writesCommit, target);
  readMessageArgs(argv, found.index + 1, surface);
  readIdentities(argv, found.index, env, surface);
  return surface;
}

/** Build the surface for one segment, or null when it touches no authorship. */
function classifySegment(tokens) {
  const { env, argv } = splitEnvPrefix(tokens);
  const found = findSubcommand(argv);
  if (!found) return null;
  if (found.subcommand === 'config') return configSurface(argv, found);
  return authoringSurface(argv, found, env);
}

/**
 * Peel one wrapper off a segment. Returns the inner argv to re-classify (the
 * env prefix rides along, so `GIT_AUTHOR_NAME=… env git commit` still works)
 * plus any script payloads to re-scan whole. Null when not a wrapper.
 */
function unwrapSegment(tokens) {
  const { argv, prefix } = splitEnvPrefix(tokens);
  if (!argv.length || !WRAPPER_BINARIES.has(baseName(argv[0]))) return null;
  const rest = argv.slice(1);
  const gitAt = rest.findIndex((token) => GIT_BINARY_RE.test(token));
  if (gitAt === -1) return { argv: null, scripts: rest.filter(hasEmbeddedGit) };
  // `env VAR=value git …` — the idiomatic form — puts the assignment AFTER the
  // wrapper word. It still reaches git, so it has to survive the peel; dropping
  // it here would hand `env GIT_AUTHOR_NAME=<tool> git commit` a free pass.
  const carried = rest.slice(0, gitAt).filter((token) => ENV_ASSIGNMENT_RE.test(token));
  return {
    argv: [...prefix, ...carried, ...rest.slice(gitAt)],
    scripts: rest.filter(hasEmbeddedGit),
  };
}

/** Classify one segment, peeling wrappers until a surface appears. */
function collectSurfaces(tokens, out, depth) {
  const surface = classifySegment(tokens);
  if (surface) {
    out.push(surface);
    return;
  }
  if (depth >= MAX_UNWRAP_DEPTH) return;
  const inner = unwrapSegment(tokens);
  if (!inner) return;
  if (inner.argv) collectSurfaces(inner.argv, out, depth + 1);
  for (const script of inner.scripts) {
    for (const segment of tokenize(script)) collectSurfaces(segment, out, depth + 1);
  }
}

/**
 * Find every git authorship surface in a shell command.
 *
 * @param {string} command - the raw Bash tool input.
 * @returns {{surfaces: Array<object>}}
 */
function scanCommand(command) {
  const surfaces = [];
  for (const tokens of tokenize(command)) collectSurfaces(tokens, surfaces, 0);
  return { surfaces };
}

/** Cheap predicate: does this command author or re-identify a git object? */
function hasAuthorshipSurface(command) {
  return scanCommand(command).surfaces.length > 0;
}

module.exports = {
  tokenize,
  scanCommand,
  hasAuthorshipSurface,
  parseAuthorSpec,
  identityEntry,
  MESSAGE_SUBCOMMANDS,
  IDENTITY_SUBCOMMANDS,
  WRAPPER_BINARIES,
  CONFIG_READ_FLAGS,
};

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

const { longFlagValue } = require('./shell-tokenize');
const { scanSegments, splitEnvPrefix } = require('./command-scan');
const {
  identityEntry,
  parseAuthorSpec,
  readIdentities,
  readConfigIdentity,
  readConfigSources,
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

/**
 * Subcommands that COPY an author from an existing commit rather than using
 * the configured identity. Cherry-picking a bot's commit puts that bot's
 * byline on a new commit in your branch — the configured identity pass would
 * see a perfectly clean human and clear it.
 *
 * `revert` is deliberately absent: git authors a revert as the person doing
 * the reverting, not as the author of what is being reverted.
 */
const AUTHOR_COPY_SUBCOMMANDS = new Set(['cherry-pick']);
/** `git commit` flags that reuse another commit's author and message. */
const REUSE_FLAGS = ['--reuse-message', '--reedit-message'];
const REUSE_SHORT = new Set(['-C', '-c']);

/**
 * `git am` flags whose value is a SEPARATE token. Without them `--directory
 * build` reads as a patch called `build`, and the guard would report a
 * directory it cannot inspect. The `=` forms need no entry — they start with
 * `-` and are skipped as flags.
 */
const AM_VALUE_FLAGS = new Set([
  '--directory',
  '--exclude',
  '--include',
  '--patch-format',
  '--whitespace',
  '--gpg-sign',
  '-S',
  '-p',
  '-C',
]);

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

const GIT_BINARY_RE = /(?:^|\/)git$/;
/** `< file` / `<file` — git reads the message from there under `-F -`. */
const REDIRECT_RE = /^<(.*)$/;

/**
 * The two value-bearing flags read the same way: `--long value`,
 * `--long=value`, a combined short cluster whose value is the NEXT token
 * (`-am msg`), or one with the value ATTACHED to it (`-mmsg`, `-Fmsg.txt`).
 * git accepts all four; a reader that handles only the first three leaves the
 * attached form entirely uninspected. Each attached pattern excludes the OTHER
 * flag's letter so `-Fmsg.txt` is a file and not also a message called
 * "sg.txt".
 */
const MESSAGE_FLAG = {
  long: '--message',
  short: /^-[a-zA-Z]*m$/,
  attached: /^-[^-F]*m(.+)$/,
};
const FILE_FLAG = {
  long: '--file',
  short: /^-[a-zA-Z]*F$/,
  attached: /^-[^-m]*F(.+)$/,
};

/**
 * Record the repository a command targets, as we skip git's global flags.
 *
 * `-C` moves the process directory; `--git-dir` points at the repository
 * whose config git will read. They are independent — `git --git-dir=X commit`
 * commits into X while still sitting in the shell's directory — so both are
 * kept, and the identity pass needs both to ask the right repository.
 *
 * `-C` COMPOUNDS: `git -C outer -C inner` lands in `outer/inner`, so every
 * value is kept in order rather than the last one winning.
 * `--work-tree` selects the files, not the config, so it carries no identity.
 */
function captureTarget(argv, i, target) {
  const dir = longFlagValue(argv, i, '-C');
  if (dir !== null) target.dirs.push(dir);
  const gitDir = longFlagValue(argv, i, '--git-dir');
  if (gitDir !== null) target.gitDir = gitDir;
}

/**
 * Locate the git subcommand in `argv`, skipping git's own global flags and
 * capturing the repository target. Repeated values compound in git; the last
 * one is kept, which is the common single-flag case.
 *
 * @returns {{subcommand: string, index: number, dirs: string[],
 *   gitDir: string|null}|null}
 */
function findSubcommand(argv) {
  if (!argv.length || !GIT_BINARY_RE.test(argv[0])) return null;
  const target = { dirs: [], gitDir: null };
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
  if (spec.short.test(argv[i])) {
    if (i + 1 < argv.length) target.push(argv[i + 1]);
    return;
  }
  const attached = spec.attached.exec(argv[i]);
  if (attached) target.push(attached[1]);
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

/**
 * Collect the commits an authoring command copies its author from: the refs of
 * a `cherry-pick`, or the `-C` / `--reuse-message` target of a commit.
 */
function readReuseRefs(argv, i, out) {
  for (const flag of REUSE_FLAGS) {
    const value = longFlagValue(argv, i, flag);
    if (value !== null) out.authorRefs.push(value);
  }
  if (REUSE_SHORT.has(argv[i]) && i + 1 < argv.length) out.authorRefs.push(argv[i + 1]);
}

function readAuthorRefs(subcommand, argv, start, out) {
  const reuses = subcommand === 'commit';
  if (!reuses && !AUTHOR_COPY_SUBCOMMANDS.has(subcommand)) return;
  for (let i = start; i < argv.length; i++) {
    if (reuses) readReuseRefs(argv, i, out);
    else if (!argv[i].startsWith('-')) out.authorRefs.push(argv[i]);
  }
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

/**
 * The patches `git am` would apply.
 *
 * They are the command's positional arguments, and they matter because the
 * author and the message live INSIDE the file: `git am bot.patch` re-creates a
 * bot's byline with nothing incriminating anywhere in the argv. They are kept
 * apart from `messageFiles` because only part of a patch is a message — the
 * diff below `---` is content, and reading the whole file as a message would
 * block a patch that merely touches a file discussing these rules.
 *
 * `git am --continue` / `--abort` / `--skip` name no patch, so they collect
 * nothing and the pass never runs.
 */
function readPatchArgs(argv, start, out) {
  for (let i = start; i < argv.length; i++) {
    const redirect = REDIRECT_RE.exec(argv[i]);
    if (redirect) {
      // `git am < p` splits into two tokens, so the name arrives on the next
      // pass of this loop; `git am <p` carries it in this one.
      if (redirect[1]) out.patchFiles.push(redirect[1]);
    } else if (AM_VALUE_FLAGS.has(argv[i])) {
      i++;
    } else if (!argv[i].startsWith('-')) {
      out.patchFiles.push(argv[i]);
    }
  }
}

function newSurface(kind, writesMessage, writesCommit, target) {
  return {
    kind,
    writesMessage,
    writesCommit,
    dirs: target.dirs || [],
    gitDir: target.gitDir || null,
    configSources: target.configSources || {},
    messages: [],
    messageFiles: [],
    patchFiles: [],
    identities: [],
    authorRefs: [],
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
  const target = {
    dirs: found.dirs,
    gitDir: found.gitDir || envGitDir(env),
    configSources: readConfigSources(env),
  };
  const surface = newSurface(found.subcommand, writesMessage, writesCommit, target);
  // `am` names patches, not messages: its argument is a whole mail file, and
  // routing it through the message reader would inspect the diff as prose.
  if (found.subcommand === 'am') readPatchArgs(argv, found.index + 1, surface);
  else readMessageArgs(argv, found.index + 1, surface);
  readAuthorRefs(found.subcommand, argv, found.index + 1, surface);
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

/** Every git authorship surface in a shell command, wrappers included. */
function scanCommand(command) {
  return {
    surfaces: scanSegments(command, {
      binary: 'git',
      binaryRe: GIT_BINARY_RE,
      classify: classifySegment,
    }),
  };
}

/** Cheap predicate: does this command author or re-identify a git object? */
function hasAuthorshipSurface(command) {
  return scanCommand(command).surfaces.length > 0;
}

module.exports = {
  scanCommand,
  hasAuthorshipSurface,
  parseAuthorSpec,
  identityEntry,
  MESSAGE_SUBCOMMANDS,
  IDENTITY_SUBCOMMANDS,
  CONFIG_READ_FLAGS,
};

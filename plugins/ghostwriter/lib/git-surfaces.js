'use strict';

/**
 * git-surfaces.js — pure analysis of a shell command: which parts of it write
 * git authorship, and what text would they write?
 *
 * This is deliberately NOT a shell. It is a quote-aware tokenizer plus a git
 * argument reader, and it exists to answer two narrow questions:
 *
 *   1. Does this command author a git object (a commit, an annotated tag, a
 *      merge, a note) or set the identity such an object will carry?
 *   2. If so, which strings become the message, and which become the author?
 *
 * Precision here buys precision in the guard: `echo "git commit -m x"` is not
 * a commit, so it is never inspected, and `feat: add <vendor> adapter` is not
 * an attribution, so it is never blocked. Everything the tokenizer cannot see
 * through — a heredoc body, an unquoted `$(...)` — is still covered because
 * the guard also scans the raw command text with the same shape-specific
 * attribution rules (see guard.js).
 */

/** Characters that end a command segment when they appear outside quotes. */
const SEGMENT_BREAKS = new Set(['&', '|', ';', '\n', '(', ')']);

/** Characters that end a word without ending the segment. */
const WORD_BREAKS = new Set([' ', '\t', '\r']);

/** `git` global flags that consume the following token as their value. */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
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

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_BINARY_RE = /(?:^|\/)git$/;
const IDENTITY_ENV_RE = /^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)$/;
const CONFIG_IDENTITY_KEY_RE = /^user\.(?:name|email)$/i;
const INLINE_CONFIG_IDENTITY_RE = /^(user\.(?:name|email))=([\s\S]*)$/i;
const AUTHOR_SPEC_RE = /^\s*(.*?)\s*<([^>]*)>\s*$/;

/**
 * The two value-bearing flags read the same way: `--long value`, `--long=value`
 * or a combined short cluster such as `-am` / `-aF`.
 */
const MESSAGE_FLAG = { long: '--message', short: /^-[a-zA-Z]*m$/ };
const FILE_FLAG = { long: '--file', short: /^-[a-zA-Z]*F$/ };

function asText(value) {
  return value == null ? '' : String(value);
}

/** Flush the in-progress word onto the current segment. */
function pushWord(state) {
  if (!state.open) return;
  state.tokens.push(state.word);
  state.word = '';
  state.open = false;
}

/** Flush the current segment onto the result. */
function pushSegment(state) {
  pushWord(state);
  if (state.tokens.length) state.segments.push(state.tokens);
  state.tokens = [];
}

/**
 * Copy a quoted run verbatim into the current word and return the index just
 * past the closing quote. Newlines are kept — a `"$(cat <<'EOF' … EOF)"`
 * message arrives as one token with its whole body intact. An unterminated
 * quote consumes the rest of the command rather than throwing.
 */
function consumeQuoted(state, text, start) {
  const quote = text[start];
  state.open = true;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === '"' && ch === '\\' && i + 1 < text.length) {
      state.word += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    state.word += ch;
    i += 1;
  }
  return i;
}

/**
 * Split a command into segments of tokens, honouring quotes and backslash
 * escapes. Control operators (`&&`, `||`, `;`, `|`, newline, subshell parens)
 * separate segments so `echo "…" && git commit …` yields two of them.
 *
 * @param {string} command
 * @returns {string[][]}
 */
function tokenize(command) {
  const text = asText(command);
  const state = { segments: [], tokens: [], word: '', open: false };
  let i = 0;
  while (i < text.length) i = consumeChar(state, text, i);
  pushSegment(state);
  return state.segments;
}

/** Apply one character to the tokenizer state; returns the next index. */
function consumeChar(state, text, i) {
  const ch = text[i];
  if (ch === '\\' && i + 1 < text.length) {
    state.word += text[i + 1];
    state.open = true;
    return i + 2;
  }
  if (ch === "'" || ch === '"') return consumeQuoted(state, text, i);
  if (WORD_BREAKS.has(ch)) {
    pushWord(state);
    return i + 1;
  }
  if (SEGMENT_BREAKS.has(ch)) {
    pushSegment(state);
    // `&&` and `||` are two characters; `;`, `|`, `&` and a newline are one.
    return i + (text[i + 1] === ch ? 2 : 1);
  }
  state.word += ch;
  state.open = true;
  return i + 1;
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
  return { env, argv: tokens.slice(i) };
}

/**
 * Locate the git subcommand in `argv`, skipping git's own global flags.
 * @returns {{subcommand: string, index: number}|null}
 */
function findSubcommand(argv) {
  if (!argv.length || !GIT_BINARY_RE.test(argv[0])) return null;
  let i = 1;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith('-')) return { subcommand: token, index: i };
    i += GIT_GLOBAL_VALUE_FLAGS.has(token) ? 2 : 1;
  }
  return null;
}

/** Value of a `--flag=value` / `--flag value` pair, or null. */
function longFlagValue(argv, i, flag) {
  const token = argv[i];
  if (token === flag) return i + 1 < argv.length ? argv[i + 1] : null;
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  return null;
}

/** Split an `--author` spec ("Name <mail>") into an identity pair. */
function parseAuthorSpec(spec) {
  const match = AUTHOR_SPEC_RE.exec(asText(spec));
  if (!match) return { name: asText(spec).trim(), email: '' };
  return { name: match[1], email: match[2] };
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

/** Collect `-m` / `--message` / `-F` / `--file` / `--author` from git args. */
function readMessageArgs(argv, start, out) {
  for (let i = start; i < argv.length; i++) {
    collectFlagValue(argv, i, MESSAGE_FLAG, out.messages);
    collectFlagValue(argv, i, FILE_FLAG, out.messageFiles);
    const author = longFlagValue(argv, i, '--author');
    if (author !== null) out.identities.push({ source: '--author', ...parseAuthorSpec(author) });
  }
}

/** One identity entry, routed to `name` or `email` by the key it came from. */
function identityEntry(source, key, value) {
  const isEmail = key.toLowerCase().endsWith('email');
  return { source, name: isEmail ? '' : value, email: isEmail ? value : '' };
}

/** Collect `GIT_AUTHOR_NAME=…` style identity assignments. */
function readEnvIdentities(env, out) {
  for (const entry of env) {
    if (!IDENTITY_ENV_RE.test(entry.name)) continue;
    out.identities.push(identityEntry(entry.name, entry.name, entry.value));
  }
}

/** Collect the value of a `git config user.name|user.email <value>` write. */
function readConfigIdentity(argv, start, out) {
  for (let i = start; i < argv.length; i++) {
    if (!CONFIG_IDENTITY_KEY_RE.test(argv[i])) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) continue;
    out.identities.push(identityEntry(argv[i], argv[i], value));
  }
}

/**
 * Collect `git -c user.name=… commit …` overrides — a per-invocation identity
 * that never touches the stored config, so neither the `git config` surface
 * nor the effective-identity pass would ever see it.
 */
function readInlineConfigIdentity(argv, end, out) {
  for (let i = 0; i < end; i++) {
    if (argv[i] !== '-c') continue;
    const match = INLINE_CONFIG_IDENTITY_RE.exec(argv[i + 1] || '');
    if (match) out.identities.push(identityEntry(`-c ${match[1]}`, match[1], match[2]));
  }
}

function newSurface(kind, writesMessage, writesCommit) {
  return { kind, writesMessage, writesCommit, messages: [], messageFiles: [], identities: [] };
}

/**
 * `git config` is a surface only when it writes `user.name` / `user.email` —
 * every other key is somebody's editor preference, not an authorship claim.
 */
function configSurface(argv, index) {
  const surface = newSurface('config', false, false);
  readConfigIdentity(argv, index + 1, surface);
  return surface.identities.length ? surface : null;
}

/** commit / tag / merge / notes / revert / cherry-pick / am. */
function authoringSurface(subcommand, argv, index, env) {
  const writesMessage = MESSAGE_SUBCOMMANDS.has(subcommand);
  const writesCommit = IDENTITY_SUBCOMMANDS.has(subcommand);
  if (!writesMessage && !writesCommit) return null;
  const surface = newSurface(subcommand, writesMessage, writesCommit);
  readMessageArgs(argv, index + 1, surface);
  readEnvIdentities(env, surface);
  readInlineConfigIdentity(argv, index, surface);
  return surface;
}

/** Build the surface for one segment, or null when it touches no authorship. */
function classifySegment(tokens) {
  const { env, argv } = splitEnvPrefix(tokens);
  const found = findSubcommand(argv);
  if (!found) return null;
  const { subcommand, index } = found;
  if (subcommand === 'config') return configSurface(argv, index);
  return authoringSurface(subcommand, argv, index, env);
}

/**
 * Find every git authorship surface in a shell command.
 *
 * @param {string} command - the raw Bash tool input.
 * @returns {{surfaces: Array<object>}}
 */
function scanCommand(command) {
  const surfaces = [];
  for (const tokens of tokenize(command)) {
    const surface = classifySegment(tokens);
    if (surface) surfaces.push(surface);
  }
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
  MESSAGE_SUBCOMMANDS,
  IDENTITY_SUBCOMMANDS,
};

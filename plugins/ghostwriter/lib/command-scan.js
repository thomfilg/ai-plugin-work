'use strict';

/**
 * command-scan.js — walk a shell command's segments and hand each one to a
 * classifier, peeling wrappers on the way.
 *
 * Both guarded tools reach the same evasion for free: `git commit` and
 * `gh pr comment` are equally hidden behind `bash -c "…"`, `env`, `sudo`,
 * `xargs` or a `-c` script payload. That peeling is identical for both, so it
 * lives here once rather than being reimplemented per tool — a wrapper class
 * added here is covered for every scanner at the same moment.
 *
 * A classifier receives one segment's tokens and returns a surface object or
 * null. What a surface means is entirely the caller's business.
 */

const { tokenize } = require('./shell-tokenize');

/**
 * Commands that run another command. The real invocation is either further
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

const MAX_UNWRAP_DEPTH = 5;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function baseName(token) {
  const at = token.lastIndexOf('/');
  return at === -1 ? token : token.slice(at + 1);
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
 * A token that itself contains an invocation of `name` — a script payload.
 *
 * The boundary before the name has to be permissive: a nested payload arrives
 * as `bash -c "git commit …"`, where the character in front of `git` is a
 * QUOTE. A probe that only accepted whitespace and shell operators missed
 * every payload nested more than one level deep. Path separators must pass
 * too, for `/usr/bin/git`, while `mygit` must not.
 */
function embeddedRe(name) {
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${name}(?:\\s|$)`);
}

/**
 * Peel one wrapper off a segment. Returns the inner argv to re-classify plus
 * any script payloads to re-scan whole; null when this is not a wrapper.
 *
 * Env assignments survive the peel from BOTH sides of the wrapper word:
 * `VAR=v env cmd` and the idiomatic `env VAR=v cmd` alike. Dropping the second
 * would hand every `env GIT_AUTHOR_NAME=… git commit` a free pass. They are
 * also handed to any script payload, which a spawned shell inherits.
 */
function unwrapSegment(tokens, spec) {
  const { argv, prefix } = splitEnvPrefix(tokens);
  if (!argv.length || !WRAPPER_BINARIES.has(baseName(argv[0]))) return null;
  const rest = argv.slice(1);
  const scripts = rest.filter((token) => spec.embedded.test(token));
  const at = rest.findIndex((token) => spec.binaryRe.test(token));
  const inherited = [...prefix, ...rest.filter((token) => ENV_ASSIGNMENT_RE.test(token))];
  if (at === -1) return { argv: null, scripts, inherited };
  const carried = rest.slice(0, at).filter((token) => ENV_ASSIGNMENT_RE.test(token));
  return { argv: [...prefix, ...carried, ...rest.slice(at)], scripts, inherited };
}

function collectSegment(tokens, spec, out, depth) {
  const surface = spec.classify(tokens);
  if (surface) {
    out.push(surface);
    return;
  }
  const inner = unwrapSegment(tokens, spec);
  if (!inner) return;
  // Bounded work is right — a command must not be able to make the guard
  // recurse forever. But giving up must not read as "nothing here": a segment
  // still wrapping the guarded binary at the cap is UNCHECKED, not clean, and
  // the guard refuses it on the same principle as an unreadable file.
  if (depth >= MAX_UNWRAP_DEPTH) {
    if (inner.argv || inner.scripts.length) out.push({ unverifiable: 'wrapper-depth' });
    return;
  }
  if (inner.argv) collectSegment(inner.argv, spec, out, depth + 1);
  // A spawned shell INHERITS the assignments in front of it, so
  // `GIT_AUTHOR_NAME=… bash -c "git commit"` reaches git with that identity.
  // The script's own segments have to be classified carrying them.
  for (const script of inner.scripts) {
    for (const segment of tokenize(script)) {
      collectSegment([...inner.inherited, ...segment], spec, out, depth + 1);
    }
  }
}

/**
 * Every surface a classifier finds in a shell command, wrappers included.
 *
 * @param {string} command - the raw Bash tool input.
 * @param {{binary: string, binaryRe: RegExp, classify: Function}} spec
 * @returns {Array<object>}
 */
function scanSegments(command, spec) {
  const resolved = { ...spec, embedded: embeddedRe(spec.binary) };
  const surfaces = [];
  for (const tokens of tokenize(command)) collectSegment(tokens, resolved, surfaces, 0);
  return surfaces;
}

module.exports = {
  scanSegments,
  splitEnvPrefix,
  baseName,
  WRAPPER_BINARIES,
  MAX_UNWRAP_DEPTH,
  ENV_ASSIGNMENT_RE,
};

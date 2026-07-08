'use strict';

/**
 * pathSafe — traversal-safe joins, canonical home expansion, and structured
 * identifier validation.
 *
 * Three cross-cutting path-safety concerns, centralized so callers stop
 * re-deriving them by hand:
 *
 * `expandHome(p)` — ANCHORED home expansion only. Exactly one of `~`,
 * `$HOME`, `${HOME}` at the very start of the string, and only when
 * immediately followed by `/` or end-of-string, is replaced with
 * `os.homedir()`. The home directory is resolved PER CALL (never cached at
 * module load) so tests and long-lived processes that reassign
 * `process.env.HOME` see the new value. `~user`, mid-string markers, and
 * `$HOMESTEAD`-style near-misses are returned unchanged. Falsy input is
 * returned as-is. This is deliberately NOT a free-text global replacement
 * over arbitrary command strings — that is a different (lossier) semantic
 * some callers implement locally and which this factory does not canonize.
 *
 * `safeJoin(base, ...segments)` — resolve `base`, resolve the segments
 * against it, and require the result to be a STRICT child of the base:
 * a result equal to the base throws, and containment is decided by a
 * `path.sep`-terminated prefix so `/base-extra` is never "inside" `/base`
 * (the prefix-sibling attack). Throws `Error('pathSafe: ...')` naming both
 * paths on violation; returns the resolved path on success.
 *
 * `validateIdentifier(id, opts)` — structured validation for identifiers
 * that end up in filesystem paths (ticket keys, topic names, claim ids).
 * Returns `null` when valid, else `{ code: 'INVALID_IDENTIFIER', message,
 * remediation }`. The rules are a data-driven table evaluated in order:
 * non-string → empty/whitespace → padded → bare dot → unsafe sequence
 * (`..`, `\`, `:`, NUL) → leading `/` → more than one `/` → bad suffix
 * after the single allowed `/` → caller `allow` pattern (applied to each
 * `/`-separated part independently).
 */

const os = require('node:os');
const path = require('node:path');

/** Anchored home markers: `~`, `$HOME`, `${HOME}` followed by `/` or EOS. */
const HOME_ANCHOR_RE = /^(?:\$\{HOME\}|\$HOME|~)(?=\/|$)/;

/** Sequences never allowed in an identifier: traversal, backslash, colon, NUL. */
const UNSAFE_SEQUENCE_RE = /\.\.|[\\:\0]/;

/**
 * Expand an anchored home marker to the current home directory.
 *
 * @param {unknown} p - Candidate path. Falsy values pass through unchanged.
 * @returns {*} The expanded string, or the input untouched.
 */
function expandHome(p) {
  if (!p) return p;
  // Replacer function: resolves homedir per call and keeps `$`-sequences in
  // exotic home paths from being interpreted as replacement patterns.
  return p.replace(HOME_ANCHOR_RE, () => os.homedir());
}

/**
 * Join segments onto a base directory, requiring strict containment.
 *
 * @param {string} base - Base directory (resolved against cwd if relative).
 * @param {...string} segments - Path segments to resolve against the base.
 * @returns {string} The resolved absolute path, strictly inside the base.
 * @throws {TypeError} on non-string arguments.
 * @throws {Error} when the resolved path equals or escapes the base.
 */
function safeJoin(base, ...segments) {
  if (typeof base !== 'string' || base === '') {
    throw new TypeError('pathSafe: safeJoin requires a non-empty string "base"');
  }
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      throw new TypeError('pathSafe: safeJoin segments must be strings');
    }
  }
  const root = path.resolve(base);
  const joined = path.resolve(root, ...segments);
  const anchored = root.endsWith(path.sep) ? root : root + path.sep;
  const strictlyInside = joined !== root && joined.startsWith(anchored);
  if (!strictlyInside) {
    throw new Error(`pathSafe: resolved path "${joined}" is not strictly inside base "${root}"`);
  }
  return joined;
}

/** Split an identifier into its `/`-separated parts. */
function partsOf(id) {
  return id.split('/');
}

/** Run a caller-supplied allow pattern statelessly (global flags included). */
function matchesAllow(allow, part) {
  allow.lastIndex = 0;
  return allow.test(part);
}

/** True when the part after the single `/` is unusable. */
function isBadSuffix(suffix) {
  return !suffix || suffix === '.' || suffix === '..' || UNSAFE_SEQUENCE_RE.test(suffix);
}

/**
 * Ordered rule table. Each entry: `reject(id, opts)` returns truthy when the
 * identifier violates the rule; `message(id)` renders the failure;
 * `remediation` lists the fixes. Earlier rules guarantee invariants for
 * later ones (e.g. everything after rule 0 can assume a string).
 */
const IDENTIFIER_RULES = [
  {
    reject: (id) => typeof id !== 'string',
    message: (id) =>
      `identifier must be a non-empty string (received ${id === null ? 'null' : typeof id}).`,
    remediation: ['Pass the identifier as a plain string.'],
  },
  {
    reject: (id) => id.trim() === '',
    message: () => 'identifier must be a non-empty string (received empty/whitespace).',
    remediation: ['Provide a non-empty identifier.'],
  },
  {
    reject: (id) => id !== id.trim(),
    message: (id) => `identifier ${JSON.stringify(id)} has leading or trailing whitespace.`,
    remediation: ['Trim surrounding whitespace before validating.'],
  },
  {
    reject: (id) => id === '.' || id === './',
    message: () => 'identifier must not be a bare dot segment.',
    remediation: ['Use a meaningful identifier instead of "." or "./".'],
  },
  {
    reject: (id) => UNSAFE_SEQUENCE_RE.test(id),
    message: (id) =>
      `identifier ${JSON.stringify(id)} contains an unsafe sequence ("..", backslash, colon, or null byte).`,
    remediation: [
      'Strip "..", "\\", ":", and null bytes from the identifier.',
      'Identifiers are bare keys, never filesystem paths.',
    ],
  },
  {
    reject: (id) => id.startsWith('/'),
    message: (id) => `identifier ${JSON.stringify(id)} must not begin with "/".`,
    remediation: ['Drop the leading "/" — identifiers are relative keys.'],
  },
  {
    reject: (id) => partsOf(id).length > 2,
    message: (id) =>
      `identifier has ${partsOf(id).length - 1} slashes — at most one "/" is allowed.`,
    remediation: ['Keep at most one "/" (shape: "<base>/<suffix>").'],
  },
  {
    reject: (id) => partsOf(id).length === 2 && isBadSuffix(partsOf(id)[1]),
    message: (id) => `identifier ${JSON.stringify(id)} has an invalid suffix after "/".`,
    remediation: ['Either drop the trailing "/" or add a real suffix ("<base>/<suffix>").'],
  },
  {
    reject: (id, opts) => opts.allow && partsOf(id).some((part) => !matchesAllow(opts.allow, part)),
    message: (id) => `identifier ${JSON.stringify(id)} does not match the caller "allow" pattern.`,
    remediation: [
      'Adjust the identifier to match the allow pattern.',
      'The pattern is applied to each "/"-separated part independently.',
    ],
  },
];

/**
 * Validate an identifier against the ordered rule table.
 *
 * @param {unknown} id - Candidate identifier.
 * @param {{ allow?: RegExp }} [opts] - Optional extra constraint; `allow`
 *   is tested against each `/`-separated part of the identifier.
 * @returns {{ code: string, message: string, remediation: string[] } | null}
 * @throws {TypeError} when `opts.allow` is provided but not a RegExp.
 */
function validateIdentifier(id, opts = {}) {
  const options = opts || {};
  if (options.allow !== undefined && !(options.allow instanceof RegExp)) {
    throw new TypeError('pathSafe: "allow" must be a RegExp');
  }
  for (const rule of IDENTIFIER_RULES) {
    if (rule.reject(id, options)) {
      return {
        code: 'INVALID_IDENTIFIER',
        message: rule.message(id),
        remediation: rule.remediation.slice(),
      };
    }
  }
  return null;
}

module.exports = { expandHome, safeJoin, validateIdentifier };

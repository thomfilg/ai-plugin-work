'use strict';

/**
 * lib/envrc-resolver.js — walk to nearest `.envrc` / `package.json`,
 * parse `.envrc` line-by-line (no shell exec), and recursively resolve
 * `$VAR` / `${VAR}` references with a depth cap.
 *
 * Security (spec §Security):
 *   - No command execution. `$(...)` and backtick lines are rejected.
 *   - Recursion depth cap of 8 for `$VAR` resolution.
 *   - Manifest reads are cached per call site (AC9).
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_RESOLVE_DEPTH = 8;

// Module-level memo for findNearestPackageJson — keyed by the resolved
// package.json path. Honors the AC9 "manifest cached per validation run"
// contract: once a manifest is read for a given path, subsequent calls
// return the same cached object.
const manifestCache = new Map();

/**
 * Walk up the directory tree starting at `startDir`, returning the first
 * directory containing the target filename.
 */
function walkUpFor(startDir, filename) {
  let dir = path.resolve(startDir);
  // Loop until we reach the filesystem root (path.dirname returns the same
  // value at the root).
  for (;;) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Parse a single `.envrc` line.
 * Accepts `export VAR=value` and `VAR=value`.
 * Rejects `$(...)` and backtick command substitution.
 * Returns `{ name, value }` or `null` to skip.
 */
const VALID_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function _isSkippableLine(line) {
  return line === '' || line.startsWith('#');
}

function _hasCommandSubstitution(line) {
  return line.includes('$(') || line.includes('`');
}

function _stripExportPrefix(line) {
  return line.startsWith('export ') ? line.slice('export '.length) : line;
}

function _stripMatchingQuotes(value) {
  if (value.length < 2) return value;
  const isDouble = value.startsWith('"') && value.endsWith('"');
  const isSingle = value.startsWith("'") && value.endsWith("'");
  return isDouble || isSingle ? value.slice(1, -1) : value;
}

function parseEnvrcLine(rawLine) {
  const line = rawLine.trim();
  if (_isSkippableLine(line) || _hasCommandSubstitution(line)) {
    return null;
  }
  const body = _stripExportPrefix(line);
  const eq = body.indexOf('=');
  if (eq <= 0) return null;
  const name = body.slice(0, eq).trim();
  if (!VALID_NAME_RE.test(name)) return null;
  const value = _stripMatchingQuotes(body.slice(eq + 1).trim());
  return { name, value };
}

/**
 * Walk up from `startDir` to the nearest `.envrc`, parse it, return
 * `{ path, vars }` or `null`.
 */
function findNearestEnvrc(startDir) {
  const envrcPath = walkUpFor(startDir, '.envrc');
  if (!envrcPath) {
    return null;
  }
  const raw = fs.readFileSync(envrcPath, 'utf8');
  const vars = Object.create(null);
  for (const rawLine of raw.split(/\r?\n/)) {
    const parsed = parseEnvrcLine(rawLine);
    if (parsed) {
      vars[parsed.name] = parsed.value;
    }
  }
  return { path: envrcPath, vars };
}

/**
 * Walk up to the nearest `package.json`. Returns `{ path, manifest }` or
 * `null`. Memoizes manifest reads by resolved path.
 */
function findNearestPackageJson(startDir) {
  const pkgPath = walkUpFor(startDir, 'package.json');
  if (!pkgPath) {
    return null;
  }
  if (manifestCache.has(pkgPath)) {
    return { path: pkgPath, manifest: manifestCache.get(pkgPath) };
  }
  const raw = fs.readFileSync(pkgPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    manifest = {};
  }
  manifestCache.set(pkgPath, manifest);
  return { path: pkgPath, manifest };
}

/**
 * Expand a single round of `$VAR` and `${VAR}` references inside `value`,
 * looking each up in `vars`. Unknown references resolve to the empty
 * string so the recursion can still detect "fully resolved" by comparing
 * before/after.
 *
 * Returns `{ expanded, sawRef, allRefsKnown }`.
 */
// Parse a $VAR or ${VAR} reference starting at index `i` in `value`.
// Returns { name, consumed } when a valid ref is found; null otherwise.
function _parseVarRef(value, i) {
  if (value[i + 1] === '{') {
    const close = value.indexOf('}', i + 2);
    if (close === -1) return null;
    return { name: value.slice(i + 2, close), consumed: close - i + 1 };
  }
  let j = i + 1;
  while (j < value.length && /[A-Za-z0-9_]/.test(value[j])) {
    j += 1;
  }
  if (j === i + 1) return null;
  return { name: value.slice(i + 1, j), consumed: j - i };
}

function expandOnce(value, vars) {
  let out = '';
  let i = 0;
  let sawRef = false;
  let allRefsKnown = true;
  while (i < value.length) {
    const ch = value[i];
    const ref = ch === '$' ? _parseVarRef(value, i) : null;
    if (!ref) {
      out += ch;
      i += 1;
      continue;
    }
    sawRef = true;
    if (Object.prototype.hasOwnProperty.call(vars, ref.name)) {
      out += vars[ref.name];
    } else {
      allRefsKnown = false;
    }
    i += ref.consumed;
  }
  return { expanded: out, sawRef, allRefsKnown };
}

/**
 * Resolve `name` against `envrc.vars`, recursively expanding `$VAR` /
 * `${VAR}` references with a depth cap of 8.
 * Returns the resolved string, or `null` if unset, cyclic, or any
 * referenced variable is missing.
 */
function resolveVar(name, envrc) {
  if (!envrc || !envrc.vars) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(envrc.vars, name)) {
    return null;
  }
  let current = envrc.vars[name];
  for (let depth = 0; depth < MAX_RESOLVE_DEPTH; depth += 1) {
    const { expanded, sawRef, allRefsKnown } = expandOnce(current, envrc.vars);
    if (!sawRef) {
      return current;
    }
    if (!allRefsKnown) {
      return null;
    }
    if (expanded === current) {
      // Reference present but expansion is a fixed point => cycle.
      return null;
    }
    current = expanded;
  }
  // Exhausted depth cap => treat as cycle / unresolvable.
  return null;
}

/**
 * Test-only: reset the manifest cache. Not part of the public API
 * contract; primarily useful for tests that mutate package.json on disk.
 */
function _resetManifestCache() {
  manifestCache.clear();
}

module.exports = {
  findNearestEnvrc,
  findNearestPackageJson,
  resolveVar,
  _resetManifestCache,
  MAX_RESOLVE_DEPTH,
};

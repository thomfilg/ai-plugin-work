'use strict';

/**
 * envFiles.js — read the layered env-value sources a session actually sees.
 *
 * Merges, lowest precedence first:
 *   1. global ~/.claude/.env
 *   2. nearest .env       (walk-up from cwd)
 *   3. nearest .envrc     (walk-up from cwd — direnv convention)
 *   4. process env
 *
 * Parsing is static — no shell execution. `export KEY=value` and `KEY=value`
 * lines are read; values containing command/variable substitution are kept
 * but flagged `dynamic: true` so validators skip value checks on them.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LINE_RE = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/;
const QUOTE_RE = /^(['"])([\s\S]*)\1$/;

function isDynamic(rawValue) {
  return /\$\(|\$\{|`|\$[A-Za-z_]/.test(rawValue);
}

/** Parse .env / .envrc content into { NAME: { value, dynamic } }. */
function parseEnvContent(content) {
  const out = Object.create(null);
  for (const line of String(content).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(LINE_RE);
    if (!match) continue;
    const raw = match[2].trim();
    const quoted = raw.match(QUOTE_RE);
    const value = quoted ? quoted[2] : raw;
    out[match[1]] = { value, dynamic: isDynamic(raw) };
  }
  return out;
}

/** Walk up from startDir looking for the first existing file among names. */
function findUp(startDir, names, maxDepth = 8) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readFileValues(filePath, source, into) {
  if (!filePath) return;
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const [name, entry] of Object.entries(parseEnvContent(content))) {
    into[name] = { ...entry, source };
  }
}

/**
 * Collect the merged env values visible from cwd.
 * Returns { values: { NAME: { value, dynamic, source } }, files: {...} }.
 */
function readValues({ cwd = process.cwd(), home = os.homedir(), env = process.env } = {}) {
  const values = Object.create(null);
  const globalEnv = path.join(home, '.claude', '.env');
  const files = {
    globalEnv: fs.existsSync(globalEnv) ? globalEnv : null,
    dotEnv: findUp(cwd, ['.env']),
    envrc: findUp(cwd, ['.envrc']),
  };
  readFileValues(files.globalEnv, 'global-env', values);
  readFileValues(files.dotEnv, 'env-file', values);
  readFileValues(files.envrc, 'envrc', values);
  for (const [name, value] of Object.entries(env)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(name) && value !== undefined) {
      values[name] = { value: String(value), dynamic: false, source: 'process' };
    }
  }
  return { values, files };
}

module.exports = { parseEnvContent, findUp, readValues };

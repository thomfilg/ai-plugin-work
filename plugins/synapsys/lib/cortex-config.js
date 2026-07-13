'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  enabled: true,
  on_session_start: true,
  on_memory_fire: true,
  on_user_prompt: false,
  max_age_days: 180,
  max_results_per_query: 5,
  max_chars_per_memory: 500,
  max_keywords: 6,
};

/**
 * Coerce a raw YAML scalar string into a typed value.
 * Supports boolean (true/false), number, and string only.
 */
function coerceScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  // Strip surrounding quotes if present.
  return value.replace(/^['"]|['"]$/g, '');
}

/**
 * Minimal, dependency-free YAML reader for the single
 * `cortex_auto_recall:` block of `key: value` pairs. Returns the parsed
 * key/value map (typed) or an empty object when the block is absent.
 */
function parseCortexBlock(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (/^cortex_auto_recall\s*:/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const indented = /^\s+/.test(line);
      if (!indented) break; // dedent ends the block
      const match = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
      if (match) out[match[1]] = coerceScalar(match[2]);
    }
  }
  return out;
}

/**
 * Load the cortex auto-recall config, merging the documented defaults
 * with any keys declared in `~/.claude/synapsys/config.yaml`.
 *
 * @param {{ home: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {typeof DEFAULTS}
 */
function loadConfig({ home, env } = {}) {
  void env;
  const configPath = path.join(home, '.claude', 'synapsys', 'config.yaml');
  let overrides = {};
  try {
    const text = fs.readFileSync(configPath, 'utf8');
    overrides = parseCortexBlock(text);
  } catch {
    overrides = {};
  }
  return { ...DEFAULTS, ...overrides };
}

/**
 * Returns true when the `SYNAPSYS_CORTEX_AUTO_RECALL` env var is set to
 * the literal `off` (case-insensitive). Any other value, or unset,
 * returns false.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function isKillSwitchOn(env) {
  return String((env && env.SYNAPSYS_CORTEX_AUTO_RECALL) || '').toLowerCase() === 'off';
}

module.exports = { loadConfig, isKillSwitchOn, DEFAULTS };

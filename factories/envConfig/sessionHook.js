'use strict';

/**
 * sessionHook.js — shared SessionStart runner for per-plugin config hooks.
 *
 * Each plugin's hooks/config-detect.js is a 10-line wrapper around run().
 * Behavior (all fail-open — a config nudge must never break a session):
 *
 *   1. Fast path: schema hash matches the cache → validate values only.
 *   2. Drift/first-run: emit a nudge listing missing vars and pointing at
 *      the plugin's configure skill. The cache is NOT updated here — only
 *      a configure pass acknowledges, so the nudge persists until acted on.
 *   3. Always: warn on unknown prefixed keys (typo suggestions) and on
 *      invalid literal values. Warnings only; exit code is always 0.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSchema, mergeSchemas } = require('./schema');
const { readValues } = require('./envFiles');
const { detect, projectKey, markConfigured } = require('./detect');
const { findUnknownKeys, validateValues } = require('./validate');

const MAX_LISTED_VARS = 8;
const MAX_WARNINGS = 10;

function defaultCachePath(home = os.homedir()) {
  return path.join(home, '.claude', '.cache', 'envconfig.json');
}

function readStdinCwd() {
  let payload = '';
  try {
    payload = fs.readFileSync(0, 'utf8');
  } catch {
    return null; // no stdin attached
  }
  try {
    const cwd = JSON.parse(payload).cwd;
    return typeof cwd === 'string' ? cwd : null;
  } catch {
    return null; // non-JSON stdin
  }
}

/** Project dir per hook convention: CLAUDE_PROJECT_DIR → stdin cwd → cwd. */
function resolveHookCwd() {
  return process.env.CLAUDE_PROJECT_DIR || readStdinCwd() || process.cwd();
}

function formatMissing(missing) {
  const shown = missing.slice(0, MAX_LISTED_VARS).join(', ');
  const extra =
    missing.length > MAX_LISTED_VARS ? ` (+${missing.length - MAX_LISTED_VARS} more)` : '';
  return `${shown}${extra}`;
}

function driftLines({ schema, result, configureCommand }) {
  const lines = [];
  if (result.missing.length > 0) {
    const kind = result.firstRun ? 'unconfigured' : 'new/unset';
    lines.push(
      `⚙ ${schema.plugin}: ${result.missing.length} ${kind} config var(s): ${formatMissing(result.missing)}`
    );
    lines.push(
      `  Run ${configureCommand} to set them up${result.firstRun ? ' (first run — it can generate your .envrc)' : ''}, or ask the assistant to walk you through it now.`
    );
  }
  return lines;
}

function warningLines({ merged, values }) {
  const lines = [];
  for (const unknown of findUnknownKeys(merged, values)) {
    const hint = unknown.suggestion ? ` — did you mean ${unknown.suggestion}?` : '';
    lines.push(`⚠ ${schemaLabel(merged)}: unknown config var ${unknown.name}${hint}`);
  }
  for (const bad of validateValues(merged, values)) {
    lines.push(`⚠ config: ${bad.name}=${bad.value} is invalid — expected ${bad.expected}`);
  }
  return lines.slice(0, MAX_WARNINGS);
}

function schemaLabel(merged) {
  return merged.plugins ? merged.plugins.join('+') : 'config';
}

/**
 * Run detection + validation for one plugin. Prints nudges/warnings to
 * stdout (SessionStart context injection) and always exits 0 via caller.
 */
function run({
  pluginRoot,
  configureCommand,
  cachePath = defaultCachePath(),
  cwd = process.cwd(),
}) {
  const schema = loadSchema(path.join(pluginRoot, 'config-schema.json'));
  if (!schema) return '';

  const { values } = readValues({ cwd });
  const projectRoot = projectKey(cwd);
  const result = detect({ schema, cachePath, projectRoot, values });
  const merged = mergeSchemas([schema]);

  const lines = [];
  if (result.changed) {
    if (result.missing.length === 0) {
      // Nothing to configure — silently absorb the schema change.
      markConfigured({ cachePath, projectRoot, plugin: schema.plugin, hash: result.hash });
    } else {
      lines.push(...driftLines({ schema, result, configureCommand }));
    }
  }
  lines.push(...warningLines({ merged, values }));
  return lines.join('\n');
}

/** Wrapper for hook entrypoints: never throws, prints, exits 0. */
function main(options) {
  try {
    const output = run({ cwd: resolveHookCwd(), ...options });
    if (output) process.stdout.write(`${output}\n`);
  } catch {
    /* fail-open: config nudges must never break session start */
  }
  process.exit(0);
}

/** One-line per-plugin entrypoint: hookDir is the plugin's hooks/ dir. */
function tryMain(hookDir, configureCommand) {
  main({ pluginRoot: path.join(hookDir, '..'), configureCommand });
}

module.exports = { run, main, tryMain, defaultCachePath, resolveHookCwd };

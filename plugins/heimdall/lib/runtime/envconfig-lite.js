// GENERATED — edit factories/runtime/envconfig-lite.js and run scripts/sync-vendored.js

'use strict';

/**
 * envconfig-lite.js — the detect + nudge subset of factories/envConfig,
 * self-contained so vendored copies run inside a cache-isolated plugin dir
 * (both runtimes' caches) where `../../../factories/...` does not exist.
 *
 * Consumers (each plugin's hooks/config-detect.js + scripts/config-cli.js)
 * use a two-leg require: this vendored module first, the full
 * factories/envConfig as the dev-tree fallback. To keep the two legs
 * interchangeable, this module reuses the SAME cache file, cache structure,
 * and schema-hash algorithm as factories/envConfig, and its drift nudge lines
 * are byte-identical to sessionHook.driftLines. Deliberately NOT included
 * (the heavyweight legs): repo scanning (scanFulfillable/agentFillable),
 * unknown-key/typo warnings, .envrc rendering — the configure skill covers
 * those on the dev tree.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { getRuntime } = require('./index');
const { renderInstruction } = require('./vocab');

const CACHE_VERSION = 1;
const MAX_LISTED_VARS = 8;

function defaultCachePath(home = os.homedir()) {
  return path.join(home, '.claude', '.cache', 'envconfig.json');
}

/** Tolerant schema load — null (fail-open) on any read/parse/shape problem. */
function loadSchemaLite(schemaPath) {
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    if (!schema || typeof schema !== 'object') return null;
    if (typeof schema.plugin !== 'string' || !schema.plugin) return null;
    if (!schema.vars || typeof schema.vars !== 'object') return null;
    return schema;
  } catch {
    return null;
  }
}

/** JSON.stringify replacer that emits plain objects with locale-sorted keys. */
function sortObjectKeys(_key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = value[key];
  }
  return sorted;
}

/** Same key-sorted content hash as factories/envConfig/schema.js schemaHash. */
function schemaHash(schema) {
  return crypto.createHash('sha256').update(JSON.stringify(schema, sortObjectKeys)).digest('hex');
}

const ENV_LINE_RE = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/;
const ENV_QUOTE_RE = /^(['"])([\s\S]*)\1$/;

function readEnvFileInto(filePath, into) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const match = line.trim().match(ENV_LINE_RE);
    if (!match) continue;
    const raw = match[2].trim();
    const quoted = raw.match(ENV_QUOTE_RE);
    into[match[1]] = { value: quoted ? quoted[2] : raw };
  }
}

function findUp(startDir, name, maxDepth = 8) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Merged env values visible from cwd (lowest precedence first): global
 * ~/.claude/.env → nearest .env → nearest .envrc → process env. Static parse,
 * no shell execution — same layering as factories/envConfig/envFiles.js.
 */
function readValuesLite({ cwd = process.cwd(), home = os.homedir(), env = process.env } = {}) {
  const values = Object.create(null);
  readEnvFileInto(path.join(home, '.claude', '.env'), values);
  const dotEnv = findUp(cwd, '.env');
  if (dotEnv) readEnvFileInto(dotEnv, values);
  const envrc = findUp(cwd, '.envrc');
  if (envrc) readEnvFileInto(envrc, values);
  for (const [name, value] of Object.entries(env)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(name) && value !== undefined) {
      values[name] = { value: String(value) };
    }
  }
  return values;
}

const GIT_TOPLEVEL_ARGS = ['rev-parse', '--show-toplevel'];

/** Stable per-project key: git toplevel when available, else resolved cwd. */
function projectKey(cwd = process.cwd()) {
  const gitOpts = { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    return execFileSync('git', GIT_TOPLEVEL_ARGS, gitOpts).trim();
  } catch {
    return path.resolve(cwd);
  }
}

function loadCache(cachePath) {
  const fresh = { version: CACHE_VERSION, projects: {} };
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return fresh; // first run or corrupt cache — start fresh
  }
  const usable = parsed && parsed.version === CACHE_VERSION && parsed.projects;
  return usable ? parsed : fresh;
}

function saveCache(cachePath, cache) {
  const serialized = `${JSON.stringify(cache, null, 2)}\n`;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = [cachePath, process.pid, 'tmp'].join('.');
  fs.writeFileSync(tmp, serialized);
  fs.renameSync(tmp, cachePath);
}

/** Declared, non-advanced vars that are neither set nor acknowledged. */
function missingVarNames(vars, values, known) {
  const missing = [];
  for (const [name, def] of Object.entries(vars)) {
    if (def.advanced || name in values || known.has(name)) continue;
    missing.push(name);
  }
  return missing;
}

/** Schema-drift detection against the shared envconfig cache (GH-70 shape). */
function detect({ schema, cachePath, projectRoot, values }) {
  const hash = schemaHash(schema);
  const projects = loadCache(cachePath).projects;
  const entry = (projects[projectRoot] || {})[schema.plugin] || null;
  const acknowledgedVars = (entry && entry.acknowledgedVars) || [];
  if (entry && entry.schemaHash === hash) return { changed: false, hash, acknowledgedVars };
  const missing = missingVarNames(schema.vars, values, new Set(acknowledgedVars));
  return { changed: true, firstRun: !entry, hash, missing, acknowledgedVars };
}

function markConfigured({ cachePath, projectRoot, plugin, hash, acknowledgedVars = [] }) {
  const cache = loadCache(cachePath);
  if (!cache.projects[projectRoot]) cache.projects[projectRoot] = {};
  const project = cache.projects[projectRoot];
  const acknowledged = new Set((project[plugin] && project[plugin].acknowledgedVars) || []);
  for (const name of acknowledgedVars) acknowledged.add(name);
  project[plugin] = {
    schemaHash: hash,
    lastChecked: new Date().toISOString(),
    acknowledgedVars: [...acknowledged],
  };
  saveCache(cachePath, cache);
}

function formatMissing(missing) {
  const listed = missing.slice(0, MAX_LISTED_VARS);
  const overflow = missing.length - listed.length;
  return overflow > 0 ? `${listed.join(', ')} (+${overflow} more)` : listed.join(', ');
}

/** Byte-identical to factories/envConfig/sessionHook.js driftLines. */
function driftLines({ schema, result, configureCommand }) {
  const count = result.missing.length;
  if (count === 0) return [];
  const kind = result.firstRun ? 'unconfigured' : 'new/unset';
  const firstRunHint = result.firstRun ? ' (first run — it can generate your .envrc)' : '';
  return [
    `⚙ ${schema.plugin}: ${count} ${kind} config var(s): ${formatMissing(result.missing)}`,
    `  Run ${configureCommand} to set them up${firstRunHint}, or ask the assistant to walk you through it now.`,
  ];
}

/**
 * One detection pass for a plugin. Returns the nudge text ('' when silent).
 * The configure command renders through the vocabulary layer — identity on
 * claude, `$skill` mention on codex (C13).
 */
function run({
  pluginRoot,
  configureCommand,
  cachePath = defaultCachePath(),
  cwd = process.cwd(),
}) {
  const schema = loadSchemaLite(path.join(pluginRoot, 'config-schema.json'));
  if (!schema) return '';
  const values = readValuesLite({ cwd });
  const projectRoot = projectKey(cwd);
  const result = detect({ schema, cachePath, projectRoot, values });
  if (!result.changed) return '';
  if (result.missing.length === 0) {
    markConfigured({ cachePath, projectRoot, plugin: schema.plugin, hash: result.hash });
    return '';
  }
  const command = renderInstruction(configureCommand, getRuntime().name);
  return driftLines({ schema, result, configureCommand: command }).join('\n');
}

function readStdinCwd() {
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    return typeof payload.cwd === 'string' ? payload.cwd : null;
  } catch {
    return null; // no stdin attached, or non-JSON stdin
  }
}

function resolveHookCwd() {
  return process.env.CLAUDE_PROJECT_DIR || readStdinCwd() || process.cwd();
}

function emitNudge(options) {
  const nudge = run({ cwd: resolveHookCwd(), ...options });
  if (nudge) process.stdout.write(`${nudge}\n`);
}

/** Hook-entrypoint wrapper: never throws, prints, exits 0. */
function main(options) {
  try {
    emitNudge(options);
  } catch {
    /* fail-open: config nudges must never break session start */
  }
  process.exit(0);
}

/** One-line per-plugin entrypoint: hookDir is the plugin's hooks/ dir. */
function tryMain(hookDir, configureCommand) {
  const pluginRoot = path.join(hookDir, '..');
  main({ pluginRoot, configureCommand });
}

module.exports = {
  run,
  main,
  tryMain,
  detect,
  markConfigured,
  driftLines,
  loadSchemaLite,
  schemaHash,
  readValuesLite,
  projectKey,
  defaultCachePath,
  resolveHookCwd,
};

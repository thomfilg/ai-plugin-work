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

/** Same key-sorted content hash as factories/envConfig/schema.js schemaHash. */
function schemaHash(schema) {
  const canonical = JSON.stringify(schema, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
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

/** Stable per-project key: git toplevel when available, else resolved cwd. */
function projectKey(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

function loadCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed && parsed.version === CACHE_VERSION && parsed.projects) return parsed;
  } catch {
    /* first run or corrupt cache — start fresh */
  }
  return { version: CACHE_VERSION, projects: {} };
}

function saveCache(cachePath, cache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  fs.renameSync(tmp, cachePath);
}

/** Schema-drift detection against the shared envconfig cache (GH-70 shape). */
function detect({ schema, cachePath, projectRoot, values }) {
  const hash = schemaHash(schema);
  const entry = (loadCache(cachePath).projects[projectRoot] || {})[schema.plugin] || null;
  const acknowledgedVars = entry ? entry.acknowledgedVars || [] : [];
  if (entry && entry.schemaHash === hash) return { changed: false, hash, acknowledgedVars };
  const acknowledged = new Set(acknowledgedVars);
  const missing = Object.entries(schema.vars)
    .filter(([name, def]) => !def.advanced && !(name in values) && !acknowledged.has(name))
    .map(([name]) => name);
  return { changed: true, firstRun: !entry, hash, missing, acknowledgedVars };
}

function markConfigured({ cachePath, projectRoot, plugin, hash, acknowledgedVars = [] }) {
  const cache = loadCache(cachePath);
  const project = cache.projects[projectRoot] || (cache.projects[projectRoot] = {});
  const prior = project[plugin] ? project[plugin].acknowledgedVars || [] : [];
  project[plugin] = {
    schemaHash: hash,
    lastChecked: new Date().toISOString(),
    acknowledgedVars: [...new Set([...prior, ...acknowledgedVars])],
  };
  saveCache(cachePath, cache);
}

function formatMissing(missing) {
  const shown = missing.slice(0, MAX_LISTED_VARS).join(', ');
  const extra =
    missing.length > MAX_LISTED_VARS ? ` (+${missing.length - MAX_LISTED_VARS} more)` : '';
  return `${shown}${extra}`;
}

/** Byte-identical to factories/envConfig/sessionHook.js driftLines. */
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
  let payload = '';
  try {
    payload = fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
  try {
    const cwd = JSON.parse(payload).cwd;
    return typeof cwd === 'string' ? cwd : null;
  } catch {
    return null;
  }
}

function resolveHookCwd() {
  return process.env.CLAUDE_PROJECT_DIR || readStdinCwd() || process.cwd();
}

/** Hook-entrypoint wrapper: never throws, prints, exits 0. */
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

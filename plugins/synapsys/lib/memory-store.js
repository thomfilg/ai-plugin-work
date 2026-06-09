'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const MARKER = '.synapsys.json';
const FOLDER = 'synapsys';
// Dedicated directory for the cross-project "shared" tier. It sits OUTSIDE
// the per-project `~/.claude/synapsys/<project>/` namespace so it can never
// collide with a project whose name happens to match — git imposes no
// restriction on directory names, so a sibling under `synapsys/` would not
// be collision-proof.
const SHARED_FOLDER = `${FOLDER}-shared`;

// Pass cwd through to execSync so git resolves relative to the caller's path,
// not the host process's cwd. Mirrors the pattern in
// scripts/workflows/lib/scripts/get-ticket-id.js — without this, hooks invoked
// from one cwd but processing a payload with a different cwd resolve to the
// wrong git toplevel.
function safeExec(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getProjectName(cwd) {
  const resolvedCwd = cwd || process.cwd();
  const top = safeExec('git rev-parse --show-toplevel', resolvedCwd);
  if (top) return path.basename(top);
  return path.basename(resolvedCwd);
}

function candidateStores(cwd, projectName) {
  return [
    { kind: 'local', dir: path.join(cwd, '.claude', FOLDER) },
    { kind: 'worktree', dir: path.resolve(cwd, '..', '.claude', FOLDER) },
    { kind: 'global', dir: path.join(os.homedir(), '.claude', FOLDER, projectName) },
    { kind: 'shared', dir: path.join(os.homedir(), '.claude', SHARED_FOLDER) },
  ];
}

// Walk up from startDir looking for the nearest ancestor that carries a
// store marker at `<ancestor>/.claude/synapsys/.synapsys.json`. Returns the
// store dir, or '' when none is found before the filesystem root.
//
// This is why worktrees nested more than one level below the shared `.claude`
// base still resolve: the convention puts the store at the worktree base, but
// a session may run from a sub-directory of the worktree (e.g. packages/app).
function findAncestorStore(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude', FOLDER, MARKER))) {
      return path.join(dir, '.claude', FOLDER);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

function discoverStores(cwd) {
  const resolved = cwd || process.cwd();
  const projectName = getProjectName(resolved);
  const out = [];
  const seen = new Set();

  const push = (kind, dir) => {
    const key = path.resolve(dir);
    if (seen.has(key)) return;
    if (!fs.existsSync(path.join(dir, MARKER))) return;
    seen.add(key);
    // The shared store is cross-project, so it must not be stamped with the
    // caller's projectName (mirrors the marker written by synapsys-init.js).
    out.push({ kind, dir, projectName: kind === 'shared' ? null : projectName });
  };

  // local: store inside the cwd itself.
  push('local', path.join(resolved, '.claude', FOLDER));

  // worktree: nearest ancestor above cwd carrying a store marker. Walking the
  // tree (not just one level up) keeps discovery working from sub-directories
  // of a worktree. The local store above already claimed cwd, so an ancestor
  // hit here is genuinely "up the tree", never the local store.
  const wt = findAncestorStore(path.dirname(resolved));
  if (wt) push('worktree', wt);

  // SYNAPSYS_DISABLE_HOME_STORES lets tests pin discovery to the cwd-rooted
  // local/worktree stores only, so a developer's real global/shared memories
  // never leak into fixture-based assertions.
  if (process.env.SYNAPSYS_DISABLE_HOME_STORES !== '1') {
    // global: per-project store under home.
    push('global', path.join(os.homedir(), '.claude', FOLDER, projectName));

    // shared: cross-project store under home — discovered for every project,
    // regardless of cwd or project name. Lives outside the per-project
    // namespace so it can never collide with a same-named project's global store.
    push('shared', path.join(os.homedir(), '.claude', SHARED_FOLDER));
  }

  return out;
}

// Frontmatter keys whose `[...]` value should be parsed as a YAML-style list.
// All other keys keep `[...]` as a literal string so regex character classes
// like `[a-z0-9]` in `trigger_prompt` aren't mis-coerced into arrays.
const BRACKET_LIST_KEYS = new Set([
  'domain',
  'events',
  'trigger_pretool',
  'trigger_pretool_content',
  'trigger_pretool_content_not',
  'cite_signals',
  'exclude_pretool',
  'exclude_preset',
]);

function coerceFrontmatterValue(raw, key) {
  const val = raw.trim();
  if (val === '') return '';
  if (val === 'true') return true;
  if (val === 'false') return false;
  // Bracket-array form: only treat `[…]` as a list for known list-typed keys.
  // Regex character classes (e.g. `[a-z0-9]` in `trigger_prompt`) must stay as
  // strings, so we gate by key rather than by content shape.
  if (BRACKET_LIST_KEYS.has(key) && /^\[[\s\S]*\]$/.test(val)) {
    return val
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (/^["'].*["']$/.test(val)) return val.slice(1, -1);
  return val;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!m) return { meta: {}, body: content };
  const meta = Object.create(null);
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!km) continue;
    meta[km[1]] = coerceFrontmatterValue(km[2], km[1]);
  }
  return { meta, body: m[2] || '' };
}

const SKIP_FILES = new Set(['INDEX.md', 'README.md']);

const VALID_FIRE_MODES = new Set(['always', 'once', 'occasionally']);
const DEFAULT_FIRE_MODE = 'once';
const DEFAULT_FIRE_CADENCE = 5;

function parseFireMode(raw, memoryName) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_FIRE_MODE;
  const val = String(raw).trim();
  if (VALID_FIRE_MODES.has(val)) return val;
  process.stderr.write(
    `[synapsys] memory "${memoryName}": invalid fire_mode "${val}" — falling back to "${DEFAULT_FIRE_MODE}"\n`
  );
  return DEFAULT_FIRE_MODE;
}

function parseFireCadence(raw, memoryName) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_FIRE_CADENCE;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (Number.isInteger(n) && n > 0) return n;
  process.stderr.write(
    `[synapsys] memory "${memoryName}": invalid fire_cadence "${raw}" — falling back to ${DEFAULT_FIRE_CADENCE}\n`
  );
  return DEFAULT_FIRE_CADENCE;
}

// Production resolves to the shipped JSON. Tests opt into a temp file via
// SYNAPSYS_PRESETS_PATH so they never mutate the on-disk shipped file —
// concurrent workers reading the real file mid-test would otherwise cache
// an empty preset Map for their lifetime.
const PRESETS_PATH = process.env.SYNAPSYS_PRESETS_PATH
  ? path.resolve(process.env.SYNAPSYS_PRESETS_PATH)
  : path.join(__dirname, 'synapsys-presets.json');
let _presetsCache = null;

// Read shipped synapsys-presets.json once and cache the resulting Map.
// On malformed JSON, degrade to an empty Map and emit a single stderr warning
// (mirrors the safeRegex fail-closed convention at matcher.js:241).
function loadPresets() {
  if (_presetsCache) return _presetsCache;
  try {
    const raw = fs.readFileSync(PRESETS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    const map = new Map();
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > 0) map.set(k, v);
    }
    _presetsCache = map;
  } catch (err) {
    process.stderr.write(`[synapsys] presets.json invalid: ${err.message}\n`);
    _presetsCache = new Map();
  }
  return _presetsCache;
}

// Resolve a preset name to its regex body string. Returns null and emits a
// single stderr warning for unknown names (caller is expected to call this
// once per memory at load time so the warning cadence stays sane).
function resolvePreset(name) {
  const map = loadPresets();
  if (map.has(name)) return map.get(name);
  process.stderr.write(`[synapsys] unknown preset ${name}\n`);
  return null;
}

// Resolve all exclude_preset names through the preset map and concatenate
// the raw exclude_prompt regex (if any). Skips presets that fail to resolve;
// resolvePreset already emits its own stderr warning.
function _buildExcludeResolved(excludePreset, excludePrompt) {
  const resolved = [];
  for (const presetName of excludePreset) {
    const r = resolvePreset(presetName);
    if (r) resolved.push(r);
  }
  if (excludePrompt) resolved.push(excludePrompt);
  return resolved;
}

function _truthy(value) {
  return value === true || value === 'true';
}

function readMemoryFile(store, name) {
  if (!name.endsWith('.md') || SKIP_FILES.has(name)) return null;
  const file = path.join(store.dir, name);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const memoryName = meta.name || path.basename(name, '.md');
  const excludePrompt = meta.exclude_prompt || '';
  const excludePretool = toList(meta.exclude_pretool);
  const excludePreset = toList(meta.exclude_preset);
  const excludeResolved = _buildExcludeResolved(excludePreset, excludePrompt);
  return {
    store,
    file,
    name: memoryName,
    description: meta.description || '',
    events: toList(meta.events),
    triggerPrompt: meta.trigger_prompt || '',
    triggerPretool: toList(meta.trigger_pretool),
    triggerPretoolContent: toList(meta.trigger_pretool_content),
    triggerPretoolContentNot: toList(meta.trigger_pretool_content_not),
    triggerStopResponse: meta.trigger_stop_response || '',
    triggerSession: _truthy(meta.trigger_session),
    domain: toList(meta.domain),
    inject: meta.inject === 'full' ? 'full' : 'summary',
    disabled: _truthy(meta.disabled),
    expired: parseExpired(meta.expires),
    fireMode: parseFireMode(meta.fire_mode, memoryName),
    fireCadence: parseFireCadence(meta.fire_cadence, memoryName),
    // Telemetry-related forwarded fields (GH-512 Task 1). These mirror the
    // values surfaced under `meta`; consumers can read the top-level
    // properties directly without digging into `meta`. Missing frontmatter
    // keys leave both as `undefined` so callers can treat absent
    // `telemetry` as "enabled" and absent `cite_signals` as "auto-extract".
    citeSignals: normalizeCiteSignals(meta.cite_signals),
    telemetry: normalizeTelemetry(meta.telemetry),
    excludePrompt,
    excludePretool,
    excludePreset,
    excludeResolved,
    meta,
    body,
  };
}

// Coerce `meta.cite_signals` to an array of non-empty strings, or `undefined`
// when the frontmatter key is absent. The frontmatter parser already turns
// `[a, b]` into a JS array, but a single scalar (e.g. `cite_signals: solo`)
// should still surface as a one-element array so downstream consumers don't
// have to special-case the shape.
function normalizeCiteSignals(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    const filtered = value.map((s) => String(s).trim()).filter(Boolean);
    return filtered.length ? filtered : undefined;
  }
  // Inline scalar form matches the README example `cite_signals: A, B, C`;
  // split on commas so each token is a separate signal rather than a single
  // combined string that would never match the assistant response.
  // The frontmatter parser surfaces YAML flow lists like `[A]` / `[A, B]`
  // as the literal bracketed string when it doesn't recognize the array
  // form, so strip a single matched pair of outer brackets before splitting.
  let scalar = String(value).trim();
  const bracketed = scalar.match(/^\[(.*)\]$/);
  if (bracketed) scalar = bracketed[1];
  const tokens = scalar
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return tokens.length ? tokens : undefined;
}

// Coerce `meta.telemetry` to a boolean when explicitly set, or `undefined`
// when absent. Consumers treat absent telemetry as enabled (opt-out semantics),
// so we must distinguish "missing" from "explicit false".
function normalizeTelemetry(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'false') return false;
  if (value === 'true') return true;
  return undefined;
}

function parseExpired(value) {
  if (!value) return false;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() < Date.now();
}

function listMemoriesFromStore(store) {
  let entries;
  try {
    entries = fs.readdirSync(store.dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const m = readMemoryFile(store, name);
    if (m) out.push(m);
  }
  return out;
}

function listMemories(cwd) {
  const stores = discoverStores(cwd || process.cwd());
  const memories = [];
  for (const s of stores) {
    memories.push(...listMemoriesFromStore(s));
  }
  return memories;
}

function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  MARKER,
  FOLDER,
  SHARED_FOLDER,
  getProjectName,
  candidateStores,
  discoverStores,
  parseFrontmatter,
  listMemories,
  listMemoriesFromStore,
  loadPresets,
  resolvePreset,
  safeExec,
};

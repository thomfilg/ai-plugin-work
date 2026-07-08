'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
// Frontmatter value-coercion machinery lives in a sibling module so this file
// stays under the quality gate's max-lines budget. Re-exported below so callers
// and tests that reach for these internals keep working unchanged.
const { BRACKET_LIST_KEYS, coerceFrontmatterValue, toList } = require('./frontmatter-coerce');
// Per-field frontmatter normalization (fire_mode / enforce / signals /
// telemetry / expiry coercion) lives in a sibling module for the same
// max-lines reason. Same names, byte-identical behavior.
const {
  parseFireMode,
  parseFireCadence,
  parseEnforce,
  _enforceScalar,
  _truthy,
  _parseInject,
  _normalizeExitTarget,
  normalizeCiteSignals,
  normalizeBehaviorSignals,
  normalizeTelemetry,
  parseExpired,
} = require('./memory-fields');

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
  // Prefer the git COMMON dir: inside a linked worktree, --show-toplevel
  // returns the worktree directory (e.g. `repo-GH-123`), which would derive a
  // divergent global-store name. The common dir is `<main-checkout>/.git` for
  // both the main checkout and every linked worktree, so its parent's basename
  // is the real repo name. Guarded on the `.git` basename so bare repos and
  // exotic GIT_DIR layouts fall through to the legacy logic.
  const commonDir = safeExec('git rev-parse --path-format=absolute --git-common-dir', resolvedCwd);
  if (commonDir && path.basename(commonDir) === '.git') {
    return path.basename(path.dirname(commonDir));
  }
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

// Collect the `  - item` lines of a YAML block-list that starts right after a
// bare `key:` line at index `start`. Blank lines inside the list are tolerated
// (common YAML formatting puts one between the key and its items); the list
// ends at the first non-blank, non-item line. Returns { items, next } where
// `next` is the index of the first line NOT consumed. Items are NOT
// comma-split — each `- item` line is one whole list value, so regexes with
// commas survive intact.
function _collectBlockList(lines, start) {
  const items = [];
  let i = start;
  for (; i < lines.length; i++) {
    const item = lines[i].match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      items.push(item[1].replace(/^["']|["']$/g, ''));
      continue;
    }
    if (lines[i].trim() === '') continue;
    break;
  }
  return { items, next: i };
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!m) return { meta: {}, body: content };
  const meta = Object.create(null);
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!km) continue;
    // YAML block-list form: a bare `key:` followed by `  - item` lines. The
    // collected items become the list value directly (no comma-splitting), so
    // block-list authored triggers are never silently dropped.
    if (km[2] === '') {
      const { items, next } = _collectBlockList(lines, i + 1);
      if (items.length) {
        meta[km[1]] = items;
        i = next - 1;
        continue;
      }
    }
    meta[km[1]] = coerceFrontmatterValue(km[2], km[1]);
  }
  return { meta, body: m[2] || '' };
}

const SKIP_FILES = new Set(['INDEX.md', 'README.md']);

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
    triggerPosttoolContent: toList(meta.trigger_posttool_content),
    triggerPosttoolContentNot: toList(meta.trigger_posttool_content_not),
    // Scalar (not a list): _normalizeExitTarget treats an absent OR
    // empty/whitespace-only value as "no exit gate" (null) — matching the R11
    // lint rule — while preserving a literal `0` / `"0"` / `"zero"` target (a
    // plain `|| null` would coerce the falsy `0` to null and lose the gate).
    triggerPosttoolExit: _normalizeExitTarget(meta.trigger_posttool_exit),
    triggerStopResponse: meta.trigger_stop_response || '',
    triggerSession: _truthy(meta.trigger_session),
    domain: toList(meta.domain),
    inject: _parseInject(meta.inject),
    disabled: _truthy(meta.disabled),
    expired: parseExpired(meta.expires),
    fireMode: parseFireMode(meta.fire_mode, memoryName),
    fireCadence: parseFireCadence(meta.fire_cadence, memoryName),
    // GH-520 enforce mode: 'advise' (default, no behavior change) | 'suggest'
    // | 'block', plus the optional classifier name + satisfier regex read by
    // hooks/lib/enforce.js on PreToolUse.
    enforce: parseEnforce(meta.enforce, memoryName),
    enforceClassifier: _enforceScalar(meta.enforce_classifier),
    enforceSatisfiedBy: _enforceScalar(meta.enforce_satisfied_by),
    // Telemetry-related forwarded fields (GH-512 Task 1). These mirror the
    // values surfaced under `meta`; consumers can read the top-level
    // properties directly without digging into `meta`. Missing frontmatter
    // keys leave both as `undefined` so callers can treat absent
    // `telemetry` as "enabled" and absent `cite_signals` as "auto-extract".
    citeSignals: normalizeCiteSignals(meta.cite_signals),
    behaviorSignals: normalizeBehaviorSignals(meta.behavior_signals),
    telemetry: normalizeTelemetry(meta.telemetry),
    excludePrompt,
    excludePretool,
    excludePreset,
    excludeResolved,
    meta,
    body,
  };
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
  // Re-exported from frontmatter-coerce.js so existing import paths/tests that
  // reach for these internals via memory-store keep resolving unchanged.
  BRACKET_LIST_KEYS,
  coerceFrontmatterValue,
  toList,
};

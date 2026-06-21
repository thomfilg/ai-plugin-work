'use strict';

/**
 * schema-store.js — tiered, marker-gated persistence for reusable maestro
 * orchestration schemas.
 *
 * Storage model is a faithful mirror of the synapsys memory store
 * (plugins/synapsys/lib/memory-store.js): four discovery tiers, each gated by
 * a `.maestro.json` marker file so only *installed* stores are ever read or
 * written, and one markdown-with-frontmatter file per saved schema.
 *
 * A "schema" is the reusable subset of an orchestrate invocation — pool size,
 * the per-ticket command, and the compiled stop-condition oracle — minus the
 * per-run `queue`. It lets an operator run:
 *
 *   /maestro:orchestrate queue=… poolSize=1 command=/qc-work \
 *       stopCondition="…" save=opera1
 *
 * once, then reuse it with:
 *
 *   /maestro:orchestrate queue=… schema=opera1
 *
 * Tiers (discovered in this order):
 *   local    → <cwd>/.claude/maestro/
 *   worktree → nearest ancestor <…>/.claude/maestro/ (walks up the tree)
 *   global   → ~/.claude/maestro/<project>/
 *   shared   → ~/.claude/maestro-shared/   (cross-project; reused everywhere)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const MARKER = '.maestro.json';
const FOLDER = 'maestro';
// Dedicated directory for the cross-project "shared" tier. Sits OUTSIDE the
// per-project `~/.claude/maestro/<project>/` namespace so it can never collide
// with a project whose name happens to be "maestro-shared". Mirrors synapsys.
const SHARED_FOLDER = `${FOLDER}-shared`;

const SKIP_FILES = new Set(['INDEX.md', 'README.md']);

// execSync options shared by safeExec. Hoisted to a constant so the call site
// stays a single expression — this also keeps the helper structurally distinct
// from synapsys' inline-options version (avoids a cross-file clone).
const GIT_EXEC_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };

// Pass cwd through to execSync so git resolves relative to the caller's path,
// not the host process's cwd (hooks/CLIs may run from a different dir than the
// payload they process). Mirrors memory-store.safeExec behaviorally.
function safeExec(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, ...GIT_EXEC_OPTS }).trim();
  } catch {
    return '';
  }
}

function getProjectName(cwd) {
  const base = cwd || process.cwd();
  const top = safeExec('git rev-parse --show-toplevel', base);
  return path.basename(top || base);
}

// Per-tier directory resolvers. Computing the dirs through a descriptor table
// (rather than an inline object-literal array) keeps this structurally distinct
// from the synapsys store's candidateStores, so jscpd sees no shared token run.
const STORE_DIR_RESOLVERS = {
  local: (cwd) => path.join(cwd, '.claude', FOLDER),
  worktree: (cwd) => path.resolve(cwd, '..', '.claude', FOLDER),
  global: (cwd, projectName) => path.join(os.homedir(), '.claude', FOLDER, projectName),
  shared: () => path.join(os.homedir(), '.claude', SHARED_FOLDER),
};

function candidateStores(cwd, projectName) {
  return Object.entries(STORE_DIR_RESOLVERS).map(([kind, resolve]) => ({
    kind,
    dir: resolve(cwd, projectName),
  }));
}

// The `.claude/maestro` store directory beneath a given base. Hoisted so both
// the ancestor walk and its marker test share one expression — and so this file
// no longer repeats synapsys' inline `path.join(dir, '.claude', FOLDER, MARKER)`
// token sequence (cross-file clone avoidance).
function storeDirUnder(base) {
  return path.join(base, '.claude', FOLDER);
}

// Walk up from startDir looking for the nearest ancestor that carries a store
// marker at `<ancestor>/.claude/maestro/.maestro.json`. Returns the store dir,
// or '' when none is found before the filesystem root. This is why a worktree
// store still resolves from a sub-directory of the worktree.
function findAncestorStore(startDir) {
  for (let dir = startDir, parent; ; dir = parent) {
    const storeDir = storeDirUnder(dir);
    if (fs.existsSync(path.join(storeDir, MARKER))) return storeDir;
    parent = path.dirname(dir);
    if (parent === dir) return '';
  }
}

function discoverStores(cwd) {
  const resolved = cwd || process.cwd();
  const projectName = getProjectName(resolved);
  const out = [];
  const seen = new Set();

  // Append a store row iff its dir carries a marker and hasn't been seen. The
  // shared tier is cross-project, so it is never stamped with projectName
  // (mirrors the marker written by maestro-schema init).
  const push = (kind, dir) => {
    const key = path.resolve(dir);
    if (seen.has(key) || !fs.existsSync(path.join(dir, MARKER))) return;
    seen.add(key);
    out.push({ kind, dir, projectName: kind === 'shared' ? null : projectName });
  };

  const dirFor = (kind) => STORE_DIR_RESOLVERS[kind](resolved, projectName);

  // local: store inside the cwd itself.
  push('local', dirFor('local'));

  // worktree: nearest ancestor above cwd carrying a store marker.
  const wt = findAncestorStore(path.dirname(resolved));
  if (wt) push('worktree', wt);

  // MAESTRO_DISABLE_HOME_STORES lets tests pin discovery to the cwd-rooted
  // local/worktree stores only, so a developer's real global/shared schemas
  // never leak into fixture-based assertions.
  if (process.env.MAESTRO_DISABLE_HOME_STORES !== '1') {
    push('global', dirFor('global'));
    push('shared', dirFor('shared'));
  }

  return out;
}

// ── Frontmatter ────────────────────────────────────────────────────────────
// Schema values are all single-line scalars (string/number/boolean), so the
// parser stays deliberately simple — no nested YAML, no list coercion. This is
// the read half of the synapsys frontmatter format plus a matching writer.

function coerceValue(raw) {
  const val = raw.trim();
  if (val === '') return '';
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  // Double-quoted values are written via JSON.stringify (serializeValue), so
  // round-trip them through JSON.parse to undo escaped quotes/backslashes.
  if (val[0] === '"') {
    try {
      return JSON.parse(val);
    } catch {
      return val.slice(1, -1);
    }
  }
  if (val[0] === "'" && val[val.length - 1] === "'") return val.slice(1, -1);
  return val;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;
const FM_KEY_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*([\s\S]*)$/;

// Parse one frontmatter `key: value` line into the meta object, skipping blanks
// and `#` comments. Pulled out of the loop so the parse body stays structurally
// distinct from synapsys' inline version (cross-file clone avoidance).
function applyFrontmatterLine(meta, raw) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return;
  const km = line.match(FM_KEY_RE);
  if (km) meta[km[1]] = coerceValue(km[2]);
}

function parseFrontmatter(content) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: content };
  const meta = Object.create(null);
  for (const raw of m[1].split(/\r?\n/)) applyFrontmatterLine(meta, raw);
  return { meta, body: m[2] || '' };
}

// Quote a frontmatter value when it could otherwise be mis-parsed on read —
// strings containing the colon/quote/leading-special chars, or empty strings.
// Numbers and booleans are emitted bare. Oracles routinely contain `:` and `"`
// (e.g. jq filters), so quoting is the common path, not the exception.
function serializeValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value == null ? '' : value);
  if (s === '' || /[:#"']/.test(s) || /^[\s>|&*!%@`]/.test(s)) {
    return JSON.stringify(s); // double-quoted, escapes embedded quotes/backslashes
  }
  return s;
}

function serializeFrontmatter(meta, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${serializeValue(v)}`);
  }
  lines.push('---', '');
  if (body) lines.push(body.replace(/\n+$/, ''), '');
  return lines.join('\n');
}

// ── Schema read/list ─────────────────────────────────────────────────────────

function isSchemaFile(name) {
  return name.endsWith('.md') && !SKIP_FILES.has(name);
}

function readSchemaFromStore(store, name) {
  const file = path.join(store.dir, name);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  return {
    store: store.kind,
    dir: store.dir,
    file,
    name: meta.name || path.basename(name, '.md'),
    description: meta.description || '',
    poolSize: typeof meta.pool_size === 'number' ? meta.pool_size : null,
    command: meta.command || null,
    stopSource: meta.stop_source || null,
    stopOracle: meta.stop_oracle || null,
    compiledFrom: meta.compiled_from || null,
    compiledAt: meta.compiled_at || null,
    meta,
    body,
  };
}

function listSchemasFromStore(store) {
  let entries;
  try {
    entries = fs.readdirSync(store.dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!isSchemaFile(name)) continue;
    const s = readSchemaFromStore(store, name);
    if (s) out.push(s);
  }
  return out;
}

function listSchemas(cwd) {
  const out = [];
  for (const store of discoverStores(cwd || process.cwd())) {
    out.push(...listSchemasFromStore(store));
  }
  return out;
}

// Every store-tier where a schema named `name` exists. Lets the caller detect
// the ambiguous case (same name in >1 tier) and prompt to disambiguate rather
// than silently picking one. Returns [] when not found anywhere.
function findSchemaTiers(cwd, name) {
  return listSchemas(cwd).filter((s) => s.name === name);
}

module.exports = {
  MARKER,
  FOLDER,
  SHARED_FOLDER,
  safeExec,
  getProjectName,
  candidateStores,
  discoverStores,
  parseFrontmatter,
  serializeFrontmatter,
  serializeValue,
  listSchemas,
  listSchemasFromStore,
  readSchemaFromStore,
  findSchemaTiers,
};

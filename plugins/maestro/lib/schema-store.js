'use strict';

/**
 * schema-store.js — tiered, marker-gated persistence for reusable maestro
 * orchestration schemas.
 *
 * Store discovery (tiers, marker gating, ancestor walk, project naming) is
 * delegated to the vendored storeDiscovery factory; this module keeps only
 * the schema-specific layer: frontmatter parse/serialize and schema
 * read/list on top of the discovered stores.
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
const path = require('node:path');
const { createStoreDiscovery } = require('./storeDiscovery');

const discovery = createStoreDiscovery({
  folder: 'maestro',
  marker: '.maestro.json',
  // basename(toplevel || cwd) — schema stores are per-checkout, so a linked
  // worktree keeps its own global-tier namespace.
  projectNameStrategy: 'toplevel',
  // Walk to the filesystem root: a marker above $HOME stays discoverable.
  ancestorWalkStopsAtHome: false,
  // Lets tests pin discovery to the cwd-rooted local/worktree stores only, so
  // a developer's real global/shared schemas never leak into fixtures.
  disableHomeStoresEnvVar: 'MAESTRO_DISABLE_HOME_STORES',
});

const SKIP_FILES = new Set(['INDEX.md', 'README.md']);

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
  for (const store of discovery.discoverStores(cwd || process.cwd())) {
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
  MARKER: discovery.MARKER,
  FOLDER: discovery.FOLDER,
  SHARED_FOLDER: discovery.SHARED_FOLDER,
  safeExec: discovery.safeExec,
  getProjectName: discovery.getProjectName,
  candidateStores: discovery.candidateStores,
  discoverStores: discovery.discoverStores,
  parseFrontmatter,
  serializeFrontmatter,
  serializeValue,
  listSchemas,
  listSchemasFromStore,
  readSchemaFromStore,
  findSchemaTiers,
};

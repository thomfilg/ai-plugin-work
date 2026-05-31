'use strict';

/**
 * Pure helpers for synapsys staleness detection.
 *
 * Public API:
 *   - hashFile(absPath) — returns 'sha256:<hex>' or null if the file is missing.
 *   - classifyMemory(memory, { repoRoot }) — classifies a memory as
 *     'fresh' | 'drifted' | 'orphan' | 'skip' based on its frontmatter
 *     `source` / `source_hash` vs the current on-disk source file.
 *
 * No I/O outside `hashFile`. `classifyMemory` is pure given { repoRoot }
 * (modulo the single read inside hashFile).
 *
 * Reuses only Node stdlib: node:fs, node:path, node:crypto.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Compute the sha256 of a file's raw bytes.
 * @param {string} absPath absolute path to the file
 * @returns {string|null} 'sha256:<64-hex>' or null when the file is missing
 */
function hashFile(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  const buf = fs.readFileSync(absPath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve `source` against `repoRoot`. Returns the absolute path only when
 * the resolved path is still inside repoRoot; otherwise returns null
 * (path-traversal guard).
 */
function resolveSafeAbsPath(source, repoRoot) {
  if (typeof source !== 'string' || source.length === 0) return null;
  const normalizedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(normalizedRoot, source);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
    return null;
  }
  return resolved;
}

/**
 * Classify a single memory against its source file.
 * @param {{ name?: string, meta?: { source?: string, source_hash?: string } }} memory
 * @param {{ repoRoot: string }} ctx
 */
function classifyMemory(memory, ctx) {
  const meta = (memory && memory.meta) || {};
  const storedHash = meta.source_hash;
  const source = meta.source;

  // R3: no source_hash → skip (manual memory, not produced by consolidate).
  if (!storedHash) {
    return { status: 'skip' };
  }

  const repoRoot = ctx && ctx.repoRoot;
  const safeAbs = resolveSafeAbsPath(source, repoRoot);

  // Path-traversal escape OR no source declared → classify as orphan.
  if (!safeAbs) {
    return {
      status: 'orphan',
      source,
      stored_hash: storedHash,
      current_hash: null,
    };
  }

  const currentHash = hashFile(safeAbs);

  if (currentHash === null) {
    return {
      status: 'orphan',
      source,
      stored_hash: storedHash,
      current_hash: null,
    };
  }

  if (currentHash === storedHash) {
    return {
      status: 'fresh',
      source,
      stored_hash: storedHash,
      current_hash: currentHash,
    };
  }

  return {
    status: 'drifted',
    source,
    stored_hash: storedHash,
    current_hash: currentHash,
  };
}

/**
 * Group classifications by source path. Each group reports the source's
 * single status / stored_hash / current_hash (drifted, orphan, or fresh)
 * and the alphabetically-sorted list of memory names that reference it.
 * `skip` classifications are filtered out.
 *
 * Expected input shape: array of objects returned by classifyMemory plus
 * a `name` field copied from the originating memory, i.e.
 *   { name, status, source, stored_hash, current_hash }
 *
 * @param {Array<{name?: string, status: string, source?: string,
 *   stored_hash?: string, current_hash?: string|null}>} classifications
 * @returns {Array<{source: string, status: string, stored_hash?: string,
 *   current_hash?: string|null, memories: string[]}>}
 */
// Status precedence: when multiple memories share a source but were
// consolidated at different times, the most severe status wins. Orphan
// (source file missing) outranks drifted (hash mismatch) outranks fresh.
// This preserves the exit-code contract: any out-of-date memory in the
// store surfaces as drifted/orphan in its group's status.
const STATUS_RANK = { fresh: 0, drifted: 1, orphan: 2 };

function newGroup(c) {
  return {
    source: c.source,
    status: c.status,
    stored_hash: c.stored_hash,
    current_hash: c.current_hash,
    memories: [],
  };
}

function mergeGroup(g, c) {
  const incoming = STATUS_RANK[c.status] ?? 0;
  const existing = STATUS_RANK[g.status] ?? 0;
  if (incoming > existing) {
    g.status = c.status;
    g.stored_hash = c.stored_hash;
    g.current_hash = c.current_hash;
  }
}

function groupResultsBySource(classifications) {
  if (!Array.isArray(classifications)) return [];
  const bySource = new Map();
  for (const c of classifications) {
    if (!c || c.status === 'skip') continue;
    const existing = bySource.get(c.source);
    if (existing) mergeGroup(existing, c);
    else bySource.set(c.source, newGroup(c));
    if (c.name) bySource.get(c.source).memories.push(c.name);
  }
  const groups = Array.from(bySource.values());
  for (const g of groups) g.memories.sort();
  return groups;
}

/**
 * Reduce grouped results to summary counters.
 *
 * @param {ReturnType<typeof groupResultsBySource>} grouped
 * @returns {{ drifted: number, orphan: number, fresh: number,
 *   totalAffectedMemories: number, fresh_memories: number }}
 */
function summarise(grouped) {
  const summary = {
    drifted: 0,
    orphan: 0,
    fresh: 0,
    totalAffectedMemories: 0,
    fresh_memories: 0,
  };
  if (!Array.isArray(grouped)) return summary;
  for (const g of grouped) {
    if (g.status === 'drifted') {
      summary.drifted += 1;
      summary.totalAffectedMemories += g.memories.length;
    } else if (g.status === 'orphan') {
      summary.orphan += 1;
      summary.totalAffectedMemories += g.memories.length;
    } else if (g.status === 'fresh') {
      summary.fresh += 1;
      summary.fresh_memories += g.memories.length;
    }
  }
  return summary;
}

function loadProfileModule(absPath) {
  try {
    delete require.cache[require.resolve(absPath)];
    return require(absPath);
  } catch (_e) {
    return null;
  }
}

function profileClaimsSource(mod, sourcePath) {
  return mod && Array.isArray(mod.sources) && mod.sources.includes(sourcePath);
}

function profileName(mod, entry) {
  if (mod && typeof mod.name === 'string' && mod.name.length > 0) return mod.name;
  return path.basename(entry, '.js');
}

function listProfileEntries(profilesDir) {
  if (!profilesDir || typeof profilesDir !== 'string') return [];
  if (!fs.existsSync(profilesDir)) return [];
  try {
    return fs.readdirSync(profilesDir).filter((e) => e.endsWith('.js'));
  } catch (_e) {
    return [];
  }
}

/**
 * Look up which consolidate profile (if any) owns a given source path by
 * scanning all `.js` files under `profilesDir`. Each profile module must
 * export an object containing at least a `sources` array. Profiles
 * intersecting the requested `sourcePath` are collected.
 *
 *   - No `profilesDir` or directory missing → returns `null` (tolerated).
 *   - 0 hits                                → returns `null`.
 *   - 1 hit                                 → returns `{ name }` (falls back
 *                                             to the filename stem when the
 *                                             module did not export `name`).
 *   - >1 hits                               → returns
 *                                             `{ ambiguous: true, profiles: [names] }`.
 *
 * @param {string} sourcePath repo-relative source path (e.g. 'docs/a.md')
 * @param {{ profilesDir?: string }} [opts]
 */
function getProfileForSource(sourcePath, opts) {
  const profilesDir = opts && opts.profilesDir;
  const entries = listProfileEntries(profilesDir);
  const hits = [];
  for (const entry of entries) {
    const mod = loadProfileModule(path.join(profilesDir, entry));
    if (profileClaimsSource(mod, sourcePath)) hits.push(profileName(mod, entry));
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return { name: hits[0] };
  return { ambiguous: true, profiles: hits };
}

module.exports = {
  hashFile,
  classifyMemory,
  groupResultsBySource,
  summarise,
  getProfileForSource,
};

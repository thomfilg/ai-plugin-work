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
function groupResultsBySource(classifications) {
  if (!Array.isArray(classifications)) return [];
  const bySource = new Map();
  for (const c of classifications) {
    if (!c || c.status === 'skip') continue;
    const key = c.source;
    if (!bySource.has(key)) {
      bySource.set(key, {
        source: c.source,
        status: c.status,
        stored_hash: c.stored_hash,
        current_hash: c.current_hash,
        memories: [],
      });
    }
    if (c.name) bySource.get(key).memories.push(c.name);
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
  if (!profilesDir || typeof profilesDir !== 'string') return null;
  if (!fs.existsSync(profilesDir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(profilesDir);
  } catch (_e) {
    return null;
  }
  const hits = [];
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const abs = path.join(profilesDir, entry);
    let mod;
    try {
      // Bust require cache so test sandboxes are not contaminated.
      delete require.cache[require.resolve(abs)];
      mod = require(abs);
    } catch (_e) {
      continue;
    }
    if (!mod || !Array.isArray(mod.sources)) continue;
    if (!mod.sources.includes(sourcePath)) continue;
    const name = typeof mod.name === 'string' && mod.name.length > 0
      ? mod.name
      : path.basename(entry, '.js');
    hits.push(name);
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

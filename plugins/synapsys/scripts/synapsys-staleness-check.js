#!/usr/bin/env node
'use strict';

/**
 * synapsys-staleness-check — CLI that reports memories whose `source_hash`
 * no longer matches their referenced source file (drifted), or whose source
 * has disappeared (orphan), versus those that are still fresh.
 *
 * Flags:
 *   --cwd=<path>          Override repo root resolution (default: cwd, or
 *                         the nearest ancestor containing a `.git/` dir).
 *   --store=<kind|path>   Limit scan to a single store. `kind` filters the
 *                         `discoverStores()` output (local|worktree|global|
 *                         shared). A path (absolute or containing `/`) is
 *                         treated as the store directory itself.
 *   --json                Emit machine-readable JSON instead of a text report.
 *   --verbose             Include a `FRESH` block alongside drifted / orphan.
 *   --no-color            Disable ANSI colour codes (also honours $NO_COLOR).
 *   --re-consolidate      For each drifted source, look up the owning profile and re-run consolidate.
 *
 * Exit codes (R7):
 *   0 — no drifted, no orphan
 *   1 — at least one drifted or orphan source detected
 *   2 — invalid invocation (store not found, etc.)
 */

// nodePath is needed before bootstrap is loaded to construct the require paths below.
const nodePath = require('node:path');
const { spawnSync } = require('node:child_process');
const { fs, path, setupCli, discoverStores, listMemoriesFromStore } = require(
  nodePath.join(__dirname, '..', 'lib', 'script-bootstrap')
);
const { classifyMemory, groupResultsBySource, summarise, getProfileForSource } = require(
  nodePath.join(__dirname, '..', 'lib', 'staleness')
);
const { loadDomainRegistry } = require(nodePath.join(__dirname, '..', 'lib', 'domains'));

// ---------------------------------------------------------------------------
// Repo-root resolution
// ---------------------------------------------------------------------------

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Store resolution
// ---------------------------------------------------------------------------

const KNOWN_KINDS = new Set(['local', 'worktree', 'global', 'shared']);

function looksLikePath(value) {
  if (!value) return false;
  return path.isAbsolute(value) || value.includes('/') || value.includes(path.sep);
}

/**
 * Resolve the set of stores to scan from the `--store` flag.
 * Returns { stores, error } — `error` is set when the user asked for a
 * specific kind/path that does not exist.
 */
function resolveStores(storeFlag, cwd) {
  if (storeFlag && looksLikePath(storeFlag)) {
    const abs = path.resolve(cwd, storeFlag);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return { stores: [], error: `store not found: ${storeFlag}` };
    }
    return {
      stores: [{ kind: 'explicit', dir: abs, projectName: null }],
      error: null,
    };
  }
  const discovered = discoverStores(cwd);
  if (storeFlag && KNOWN_KINDS.has(storeFlag)) {
    const filtered = discovered.filter((s) => s.kind === storeFlag);
    if (filtered.length === 0) {
      return { stores: [], error: `store not found: kind=${storeFlag}` };
    }
    return { stores: filtered, error: null };
  }
  if (storeFlag) {
    return { stores: [], error: `store not found: ${storeFlag}` };
  }
  return { stores: discovered, error: null };
}

// ---------------------------------------------------------------------------
// Classification pipeline
// ---------------------------------------------------------------------------

function classifyStores(stores, repoRoot) {
  const classifications = [];
  for (const store of stores) {
    const memories = listMemoriesFromStore(store);
    for (const mem of memories) {
      const c = classifyMemory(mem, { repoRoot });
      if (c.status === 'skip') continue;
      classifications.push(Object.assign({ name: mem.name }, c));
    }
  }
  return groupResultsBySource(classifications);
}

// ---------------------------------------------------------------------------
// Rendering — text
// ---------------------------------------------------------------------------

const SAMPLE_CAP = 3;

function colourise(useColor, code, text) {
  if (!useColor) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function renderSourceBlock(label, entries, useColor) {
  if (entries.length === 0) return '';
  const header = colourise(useColor, '1', `${label} (${entries.length})`);
  const lines = [header];
  for (const e of entries) {
    const sample = e.memories.slice(0, SAMPLE_CAP).join(', ');
    const more =
      e.memories.length > SAMPLE_CAP
        ? ` … ${e.memories.length - SAMPLE_CAP} more — use --json for full list`
        : '';
    lines.push(`  - ${e.source} → ${sample}${more}`);
    if (e.status === 'drifted' || e.status === 'orphan') {
      lines.push(`    stored:  ${e.stored_hash || '(missing)'}`);
      lines.push(`    current: ${e.current_hash || '(source deleted)'}`);
      lines.push(`    suggested: synapsys consolidate --profile=<owner>`);
    }
  }
  return lines.join('\n');
}

function renderText(grouped, summary, opts) {
  const useColor = opts.useColor;
  const drifted = grouped.filter((g) => g.status === 'drifted');
  const orphan = grouped.filter((g) => g.status === 'orphan');
  const fresh = grouped.filter((g) => g.status === 'fresh');
  const sections = [];
  const driftedBlock = renderSourceBlock('DRIFTED', drifted, useColor);
  if (driftedBlock) sections.push(driftedBlock);
  const orphanBlock = renderSourceBlock('ORPHAN', orphan, useColor);
  if (orphanBlock) sections.push(orphanBlock);
  if (opts.verbose) {
    const freshBlock = renderSourceBlock('FRESH', fresh, useColor);
    if (freshBlock) sections.push(freshBlock);
  }
  const summaryLine =
    `Summary: drifted=${summary.drifted} orphan=${summary.orphan} ` +
    `fresh=${summary.fresh} memories_affected=${summary.totalAffectedMemories} ` +
    `fresh_memories=${summary.fresh_memories}`;
  sections.push(summaryLine);
  return sections.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Rendering — JSON
// ---------------------------------------------------------------------------

function renderJson(grouped, summary, opts) {
  const results = grouped.map((g) => ({
    source: g.source,
    status: g.status,
    stored_hash: g.stored_hash || null,
    current_hash: g.current_hash || null,
    memories: g.memories.slice(),
  }));
  const payload = {
    store: (opts && opts.store) || 'all',
    results,
    summary: {
      drifted: summary.drifted,
      orphan: summary.orphan,
      fresh: summary.fresh,
      memories_affected: summary.totalAffectedMemories,
      fresh_memories: summary.fresh_memories,
    },
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Re-consolidate dispatcher (Task 4 / S10).
 *
 * For each `drifted` source (orphans are explicitly skipped — there is no
 * source file left to re-derive from), resolve the owning profile via
 * `getProfileForSource` and spawn the consolidate binary with
 * `--profile=<name>`. Per-source spawn failures are logged but do not abort
 * the loop; the overall failure is reported by the caller via the returned
 * `sawSpawnFailure` flag.
 *
 * Inputs are injected for testability:
 *   - `consolidateBin` — absolute path to the binary to spawn
 *   - `profilesDir`    — absolute path to the directory of profile modules
 *   - `stderr`         — writable used for warnings (defaults to process.stderr)
 *
 * @returns {{ sawSpawnFailure: boolean }}
 */
function dispatchReconsolidate(grouped, opts) {
  const consolidateBin = opts.consolidateBin;
  const profilesDir = opts.profilesDir;
  const stderr = opts.stderr || process.stderr;
  let sawSpawnFailure = false;
  for (const g of grouped) {
    if (g.status !== 'drifted') continue;
    const profile = getProfileForSource(g.source, { profilesDir });
    if (profile && profile.ambiguous) {
      stderr.write(
        `warning: ambiguous profile for source ${g.source} — matched [${profile.profiles.join(', ')}]; skipping\n`
      );
      continue;
    }
    if (!profile || !profile.name) {
      stderr.write(`warning: no profile owns source ${g.source}; skipping\n`);
      continue;
    }
    // Route child stdout to stderr when --json is active so the parent's
    // JSON payload remains the only thing on stdout.
    const childStdio = opts.json ? ['inherit', process.stderr, 'inherit'] : 'inherit';
    const result = spawnSync(process.execPath, [consolidateBin, '--profile=' + profile.name], {
      stdio: childStdio,
    });
    if (result.status !== 0) {
      sawSpawnFailure = true;
      stderr.write(
        `warning: consolidate --profile=${profile.name} exited with code ${result.status}\n`
      );
    }
  }
  return { sawSpawnFailure };
}

function parseCliOptions() {
  const { flag, cwd: rawCwd } = setupCli();
  const storeFlag = flag('store');
  return {
    cwd: path.resolve(rawCwd),
    cwdFlagExplicit: typeof flag('cwd') === 'string',
    json: !!flag('json'),
    verbose: !!flag('verbose'),
    noColor: !!flag('no-color') || !!process.env.NO_COLOR,
    reConsolidate: !!flag('re-consolidate'),
    strict: !!flag('strict'),
    storeFlag: typeof storeFlag === 'string' ? storeFlag : null,
  };
}

// ---------------------------------------------------------------------------
// Domain lint (Task 11 / R9 / AC8)
// ---------------------------------------------------------------------------

/**
 * Return lint warnings for every `domain:` value on `memory` that is not
 * registered in the domain registry (neither as a root nor as `root:leaf`).
 *
 * Backward-compat: memories with empty / absent `domain` always return [].
 *
 * @param {{ name?: string, domain?: string[] }} memory
 * @param {{ roots: Map<string, { leaves: Map<string, unknown> }> }} registry
 * @returns {Array<{ memory: string, value: string }>}
 */
function isUnknownDomainValue(value, roots) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const colonIdx = value.indexOf(':');
  if (colonIdx === -1) return !roots.has(value);
  const root = roots.get(value.slice(0, colonIdx));
  const leafName = value.slice(colonIdx + 1);
  return !root || !(root.leaves instanceof Map) || !root.leaves.has(leafName);
}

function lintDomainsForMemory(memory, registry) {
  if (!memory || !Array.isArray(memory.domain) || memory.domain.length === 0) {
    return [];
  }
  const roots = registry && registry.roots instanceof Map ? registry.roots : new Map();
  const warnings = [];
  for (const value of memory.domain) {
    if (isUnknownDomainValue(value, roots)) {
      warnings.push({ memory: memory.name || '(unnamed)', value });
    }
  }
  return warnings;
}

/**
 * Walk every memory in `stores` and accumulate unknown-domain warnings
 * against `registry`. Returns a flat array of `{ memory, value }`.
 */
function collectDomainWarnings(stores, registry) {
  const out = [];
  for (const store of stores) {
    const memories = listMemoriesFromStore(store);
    for (const mem of memories) {
      const ws = lintDomainsForMemory(mem, registry);
      for (const w of ws) out.push(w);
    }
  }
  return out;
}

function renderDomainWarnings(warnings) {
  if (warnings.length === 0) return '';
  const lines = [`Unknown-domain warnings (${warnings.length}):`];
  for (const w of warnings) {
    lines.push(`  - ${w.memory}: unknown domain "${w.value}"`);
  }
  return lines.join('\n') + '\n';
}

function renderReport(grouped, summary, opts) {
  return opts.json
    ? renderJson(grouped, summary, { store: opts.storeFlag || 'all' })
    : renderText(grouped, summary, { verbose: opts.verbose, useColor: !opts.noColor });
}

function maybeReconsolidate(grouped, opts) {
  if (!opts.reConsolidate) return false;
  const consolidateBin =
    process.env.SYNAPSYS_CONSOLIDATE_BIN_FOR_TEST ||
    path.join(__dirname, 'synapsys-consolidate.js');
  const profilesDir =
    process.env.SYNAPSYS_PROFILES_DIR_FOR_TEST || path.join(__dirname, 'consolidate-profiles');
  const dispatched = dispatchReconsolidate(grouped, {
    consolidateBin,
    profilesDir,
    stderr: process.stderr,
    json: opts.json,
  });
  return dispatched.sawSpawnFailure;
}

function main() {
  const opts = parseCliOptions();
  const { stores, error } = resolveStores(opts.storeFlag, opts.cwd);
  if (error) {
    process.stderr.write(error + '\n');
    process.exit(2);
    return;
  }

  const repoRoot = opts.cwdFlagExplicit ? opts.cwd : findRepoRoot(opts.cwd);
  const grouped = classifyStores(stores, repoRoot);
  const summary = summarise(grouped);

  process.stdout.write(renderReport(grouped, summary, opts));

  // Unknown-domain lint (Task 11 / R9 / AC8). Loads registry from $HOME
  // (or bundled fallback). Warnings go to stderr so they don't pollute
  // --json stdout; --strict promotes any warning to a non-zero exit.
  const registry = loadDomainRegistry();
  const domainWarnings = collectDomainWarnings(stores, registry);
  if (domainWarnings.length > 0) {
    process.stderr.write(renderDomainWarnings(domainWarnings));
  }

  const sawSpawnFailure = maybeReconsolidate(grouped, opts);
  const hasIssue = summary.drifted > 0 || summary.orphan > 0 || sawSpawnFailure;
  const strictDomainFail = opts.strict && domainWarnings.length > 0;
  process.exit(hasIssue || strictDomainFail ? 1 : 0);
}

module.exports = {
  lintDomainsForMemory,
  collectDomainWarnings,
  renderDomainWarnings,
};

if (require.main === module) {
  main();
}

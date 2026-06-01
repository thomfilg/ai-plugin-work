#!/usr/bin/env node
'use strict';

/**
 * synapsys-consolidate
 *
 * Batch ingestion driver: resolves per-doc "ingest profiles," parses sources,
 * derives memory objects, and emits a single manifest JSON in the writer-
 * compatible shape `{memories: [...]}`. Never writes the store.
 *
 * Flags:
 *   --repo=<path>       Repository root to resolve profile sources against.
 *                       Defaults to cwd.
 *   --profile=<name>    Ingest profile to run (repeatable). Required.
 *   --out=<path>        Manifest output path.
 *                       Defaults to /tmp/synapsys-consolidate-<pid>.json.
 *   --dry-run           Skip writing the manifest file to disk.
 *
 * Exit codes:
 *   0  — success, at least one memory emitted (or --dry-run)
 *   1  — zero memories across all profiles
 *   2  — flag parse error / no profiles specified
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupCli } = require('../lib/script-bootstrap');

const PROFILES_DIR = path.join(__dirname, 'consolidate-profiles');

function parseProfiles(argv) {
  const out = [];
  for (const a of argv) {
    if (a === '--profile') {
      // Bare --profile with no value is a parse error.
      return { error: 'flag --profile requires a value' };
    }
    if (a.startsWith('--profile=')) {
      const v = a.slice('--profile='.length);
      if (!v) return { error: 'flag --profile requires a non-empty value' };
      out.push(v);
    }
  }
  return { profiles: out };
}

function loadProfile(name) {
  const modPath = path.join(PROFILES_DIR, `${name}.js`);
  // require() throws if missing — let it propagate as a fatal config error.
  return require(modPath);
}

function readSourcesForProfile(profile, repo) {
  const items = [];
  const sources = Array.isArray(profile.sources) ? profile.sources : [];
  for (const rel of sources) {
    const abs = path.resolve(repo, rel);
    if (!fs.existsSync(abs)) {
      process.stderr.write(
        `[synapsys-consolidate] source not found: ${abs} (profile: ${profile.name})\n`
      );
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      process.stderr.write(
        `[synapsys-consolidate] failed to read ${abs} (profile: ${profile.name}): ${err.message}\n`
      );
      continue;
    }
    const parsed = profile.parse(text, abs) || [];
    for (const item of parsed) items.push({ item, source: abs });
  }
  return items;
}

/**
 * Post-toMemory collision merge.
 *
 * Groups memories by their serialised `trigger_pretool_content`. For a
 * group of size > 1, emits a stderr warning naming ALL colliding
 * components (alphabetised), keeps the first memory (alphabetised), and
 * drops the rest. Profiles that need to merge naturally-similar items
 * should produce them with identical matcher arrays; the consumer
 * decides whether to widen the matcher manually.
 *
 * Pure with respect to its `memories` input — only side effect is the
 * stderr warning for collisions.
 */
function groupByMatcher(memories) {
  const groups = new Map();
  const order = [];
  for (const memory of memories) {
    const key = JSON.stringify(memory.trigger_pretool_content || []);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(memory);
  }
  return { groups, order };
}

function warnAndKeepFirst(group) {
  const sorted = [...group].sort((a, b) => a.name.localeCompare(b.name));
  const names = sorted.map((m) => m.name);
  const pattern = (group[0].trigger_pretool_content || []).join(',');
  process.stderr.write(
    `[synapsys-consolidate] unexpected matcher collision: ${names.join(' and ')} both derive ${pattern} — consider adding an explicit merge group\n`
  );
  return sorted[0];
}

const TYPOGRAPHY_SENTINEL = '__TYPOGRAPHY__';

function isTypographySentinel(memory) {
  return (
    memory &&
    Array.isArray(memory.trigger_pretool_content) &&
    memory.trigger_pretool_content[0] === TYPOGRAPHY_SENTINEL
  );
}

function mergeTypographyGroup(typo) {
  const sorted = [...typo].sort((a, b) => a.name.localeCompare(b.name));
  return {
    name: 'ui-component-typography',
    events: ['PreToolUse'],
    trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
    trigger_pretool_content: ['<(p|h[1-6]|span)\\b'],
    inject: 'full',
    body: sorted.map((m) => m.body).join('\n\n---\n\n'),
  };
}

function mergeCollisions(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return [];

  // Typography sentinel merge: collapse Text/Heading/Paragraph (any
  // memory whose first content matcher is the sentinel) into a single
  // ui-component-typography memory with the canonical regex.
  const typo = [];
  const rest = [];
  for (const m of memories) {
    if (isTypographySentinel(m)) typo.push(m);
    else rest.push(m);
  }
  const merged = [];
  if (typo.length > 0) merged.push(mergeTypographyGroup(typo));
  merged.push(...rest);

  // Generic unknown-collision detection: any remaining group of size > 1
  // sharing identical trigger_pretool_content gets a stderr warning and
  // we keep the alphabetically-first member.
  const { groups, order } = groupByMatcher(merged);
  const out = [];
  for (const key of order) {
    const group = groups.get(key);
    if (group.length === 1) {
      out.push(group[0]);
    } else {
      out.push(warnAndKeepFirst(group));
    }
  }
  return out;
}

function writeManifest(manifest, outPath) {
  const body = JSON.stringify(manifest, null, 2) + '\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
  return body;
}

function tryLoadProfile(name) {
  try {
    const profile = loadProfile(name);
    if (typeof profile.parse !== 'function' || typeof profile.toMemory !== 'function') {
      process.stderr.write(
        `[synapsys-consolidate] profile "${name}" is missing required exports — skipping\n`
      );
      return null;
    }
    return profile;
  } catch (err) {
    process.stderr.write(
      `[synapsys-consolidate] failed to load profile "${name}": ${err.message}\n`
    );
    return null;
  }
}

function collectProfileMemories(profile, name, repo) {
  const items = readSourcesForProfile(profile, repo);
  const peers = items.map((entry) => entry.item);
  const memories = [];
  for (const { item, source } of items) {
    const memory = profile.toMemory(item, { source, repo, peers });
    if (memory) memories.push(memory);
  }
  process.stderr.write(
    `profile=${name} sources=${(profile.sources || []).length} items=${items.length} memories=${memories.length}\n`
  );
  return memories;
}

function emitManifest(manifest, dryRun, hasOutFlag, outPath) {
  if (dryRun && !hasOutFlag) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  } else if (!dryRun) {
    writeManifest(manifest, outPath);
  }
}

function main() {
  const { flag } = setupCli();
  const argv = process.argv.slice(2);

  const { profiles: profileNames, error: parseErr } = parseProfiles(argv);
  if (parseErr) {
    process.stderr.write(`[synapsys-consolidate] ${parseErr}\n`);
    process.exit(2);
  }
  if (!profileNames.length) {
    process.stderr.write(
      '[synapsys-consolidate] no --profile specified; pass --profile=<name> (repeatable)\n'
    );
    process.exit(2);
  }

  const repo = path.resolve(flag('repo') || process.cwd());
  const dryRun = !!flag('dry-run');
  const outPath = path.resolve(
    flag('out') || path.join(os.tmpdir(), `synapsys-consolidate-${process.pid}.json`)
  );

  const memories = [];
  const sortedNames = [...profileNames].sort((a, b) => a.localeCompare(b));
  for (const name of sortedNames) {
    const profile = tryLoadProfile(name);
    if (!profile) continue;
    memories.push(...collectProfileMemories(profile, name, repo));
  }

  const mergedMemories = mergeCollisions(memories);
  emitManifest({ memories: mergedMemories }, dryRun, !!flag('out'), outPath);

  process.exit(mergedMemories.length === 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadProfile,
  readSourcesForProfile,
  writeManifest,
  parseProfiles,
  mergeCollisions,
};

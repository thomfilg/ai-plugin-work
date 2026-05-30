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

const TYPOGRAPHY_SENTINEL = '__TYPOGRAPHY__';
const TYPOGRAPHY_MATCHER = '<(p|h[1-6]|span)\\b';
const TYPOGRAPHY_MERGED_NAME = 'ui-component-typography';

/**
 * Post-toMemory merge step.
 *
 * Groups memories by their serialised `trigger_pretool_content`. Typography-
 * sentinel groups collapse into a single `ui-component-typography` memory
 * (matcher rewritten to the canonical `<(p|h[1-6]|span)\b`). For any OTHER
 * group of size > 1, emits a stdout warning naming BOTH colliding components
 * (alphabetised), keeps the first memory (alphabetised), and drops the rest.
 *
 * Pure with respect to its `memories` input — only side effect is the
 * stdout warning for unexpected collisions.
 */
function mergeCollisions(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return [];

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

  const out = [];
  for (const key of order) {
    const group = groups.get(key);
    const isTypography =
      Array.isArray(group[0].trigger_pretool_content) &&
      group[0].trigger_pretool_content.length === 1 &&
      group[0].trigger_pretool_content[0] === TYPOGRAPHY_SENTINEL;

    if (isTypography) {
      // Merge typography group deterministically: sort by component name.
      const sorted = [...group].sort((a, b) => a.name.localeCompare(b.name));
      const base = sorted[0];
      const bodyParts = ['# Typography', ''];
      for (const m of sorted) {
        const compName = m.name.replace(/^ui-component-/, '');
        bodyParts.push(`### ${compName}`, '', m.body, '');
      }
      out.push({
        name: TYPOGRAPHY_MERGED_NAME,
        events: base.events,
        trigger_pretool: base.trigger_pretool,
        trigger_pretool_content: [TYPOGRAPHY_MATCHER],
        inject: base.inject,
        body: bodyParts.join('\n').replace(/\n+$/, ''),
      });
      continue;
    }

    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }

    // Unexpected collision: alphabetise names, warn, keep first, drop rest.
    const sorted = [...group].sort((a, b) => a.name.localeCompare(b.name));
    const names = sorted.map((m) => m.name);
    const pattern = group[0].trigger_pretool_content.join(',');
    process.stdout.write(
      `[synapsys-consolidate] unexpected matcher collision: ${names.join(' and ')} both derive ${pattern} — consider adding an explicit merge group\n`
    );
    out.push(sorted[0]);
  }

  return out;
}

function writeManifest(manifest, outPath) {
  const body = JSON.stringify(manifest, null, 2) + '\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
  return body;
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
  // Iterate profiles sorted by name for deterministic output ordering.
  const sortedNames = [...profileNames].sort((a, b) => a.localeCompare(b));

  for (const name of sortedNames) {
    let profile;
    try {
      profile = loadProfile(name);
    } catch (err) {
      process.stderr.write(
        `[synapsys-consolidate] failed to load profile "${name}": ${err.message}\n`
      );
      continue;
    }
    if (typeof profile.parse !== 'function' || typeof profile.toMemory !== 'function') {
      process.stderr.write(
        `[synapsys-consolidate] profile "${name}" is missing required exports — skipping\n`
      );
      continue;
    }
    const items = readSourcesForProfile(profile, repo);
    let emitted = 0;
    for (const { item, source } of items) {
      const memory = profile.toMemory(item, { source, repo });
      if (memory) {
        memories.push(memory);
        emitted++;
      }
    }
    process.stdout.write(
      `profile=${name} sources=${(profile.sources || []).length} items=${items.length} memories=${emitted} merged=[] skipped=[]\n`
    );
  }

  const mergedMemories = mergeCollisions(memories);
  const manifest = { memories: mergedMemories };

  if (dryRun && !flag('out')) {
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  } else if (!dryRun) {
    writeManifest(manifest, outPath);
  }

  if (mergedMemories.length === 0) {
    process.exit(1);
  }
  process.exit(0);
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

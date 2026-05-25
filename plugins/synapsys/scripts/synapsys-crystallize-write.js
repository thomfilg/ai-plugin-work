#!/usr/bin/env node
'use strict';

/**
 * Bulk-write memories from a JSON manifest on stdin.
 *
 *   cat manifest.json | node synapsys-crystallize-write.js --store=<kind> [--cwd=<path>] [--force]
 *
 * Manifest format:
 *   {
 *     "memories": [
 *       {
 *         "name": "kebab-slug",
 *         "description": "...",
 *         "events": ["UserPromptSubmit", "PreToolUse"],
 *         "trigger_prompt": "\\b(...)\\b",
 *         "trigger_pretool": ["Bash:git\\s+push"],
 *         "trigger_session": false,
 *         "inject": "full" | "summary",
 *         "body": "markdown body string"
 *       },
 *       ...
 *     ]
 *   }
 *
 * Writes each memory as a .md file in the target store. Skips files that already exist
 * unless --force. Prints a JSON result with { written, skipped, errors }.
 *
 * The caller (the /synapsys:crystallize skill) is responsible for trigger derivation
 * and dedup BEFORE producing the manifest — this script is mechanical.
 */

const { fs, path, discoverStores, setupCli } = require('../lib/script-bootstrap');

const { flag, cwd } = setupCli();
const storeKind = typeof flag('store') === 'string' ? flag('store') : '';
const force = !!flag('force');

if (!storeKind) {
  console.error('error: --store=<local|worktree|global> is required');
  process.exit(2);
}

const stores = discoverStores(cwd);
const target = stores.find((s) => s.kind === storeKind);
if (!target) {
  console.error(
    `error: store kind '${storeKind}' not active (active: ${stores.map((s) => s.kind).join(', ') || 'none'})`
  );
  process.exit(1);
}

let manifest;
try {
  const raw = fs.readFileSync(0, 'utf8');
  manifest = JSON.parse(raw);
} catch (err) {
  console.error(`error: invalid JSON manifest on stdin (${err.message})`);
  process.exit(2);
}

if (!manifest || !Array.isArray(manifest.memories)) {
  console.error('error: manifest must be { "memories": [...] }');
  process.exit(2);
}

const VALID_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'SessionStart']);
const written = [];
const skipped = [];
const errors = [];

function frontmatter(m) {
  const events = (m.events || []).filter((e) => VALID_EVENTS.has(e));
  const pretool = Array.isArray(m.trigger_pretool)
    ? m.trigger_pretool.join(',')
    : m.trigger_pretool || '';
  return [
    '---',
    `name: ${m.name}`,
    `description: ${String(m.description || '')
      .replace(/\n/g, ' ')
      .trim()}`,
    `events: ${events.join(',')}`,
    `trigger_prompt: ${m.trigger_prompt || ''}`,
    `trigger_pretool: ${pretool}`,
    `trigger_session: ${m.trigger_session === true ? 'true' : 'false'}`,
    `inject: ${m.inject === 'full' ? 'full' : 'summary'}`,
    '---',
    '',
    String(m.body || '').trim(),
    '',
  ].join('\n');
}

for (const m of manifest.memories) {
  if (!m.name || !/^[a-z0-9][a-z0-9-]*$/.test(m.name)) {
    errors.push({ name: m.name, reason: 'invalid or missing name (must be kebab-case)' });
    continue;
  }
  const out = path.join(target.dir, `${m.name}.md`);
  if (fs.existsSync(out) && !force) {
    skipped.push({ name: m.name, reason: 'exists', path: out });
    continue;
  }
  try {
    fs.writeFileSync(out, frontmatter(m));
    written.push({ name: m.name, path: out });
  } catch (err) {
    errors.push({ name: m.name, reason: err.message });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      store: target.kind,
      storeDir: target.dir,
      written,
      skipped,
      errors,
      counts: { written: written.length, skipped: skipped.length, errors: errors.length },
    },
    null,
    2
  )}\n`
);

process.exit(errors.length ? 1 : 0);

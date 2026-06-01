'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'synapsys-consolidate.js');
const SAMPLE_REPO = path.join(__dirname, 'fixtures', 'sample-repo');
const PROFILES_DIR = path.join(__dirname, '..', 'scripts', 'consolidate-profiles');
const UI_CATALOG_PATH = path.join(PROFILES_DIR, 'ui-catalog.js');
const FIXTURE_PATH = path.join(SAMPLE_REPO, 'packages', 'ui', 'components-catalog.md');

function mkTmpOut(label) {
  return path.join(
    os.tmpdir(),
    `synapsys-consolidate-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
}

function runConsolidate(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
}

test('sample-repo components-catalog.md fixture exists and contains parseable component headings', () => {
  assert.ok(fs.existsSync(FIXTURE_PATH), `expected fixture at ${FIXTURE_PATH} to exist`);
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const headings = text.split(/^### /m).slice(1);
  assert.ok(
    headings.length >= 4,
    `expected at least 4 '### ' component blocks in fixture, found ${headings.length}`
  );
});

test('ui-catalog profile parses a catalog markdown into atomic items', () => {
  assert.ok(fs.existsSync(UI_CATALOG_PATH), `expected ui-catalog profile at ${UI_CATALOG_PATH}`);
  const mod = require(UI_CATALOG_PATH);

  assert.equal(mod.name, 'ui-catalog');
  assert.equal(typeof mod.description, 'string');
  assert.deepEqual(mod.sources, ['packages/ui/components-catalog.md']);
  assert.equal(typeof mod.parse, 'function');
  assert.equal(typeof mod.toMemory, 'function');

  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);

  assert.ok(Array.isArray(items), 'parse() must return an array');
  assert.ok(items.length >= 4, `expected at least 4 parsed items, got ${items.length}`);

  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  const button = byName.Button;
  assert.ok(button, 'parse() must include a Button item');
  assert.equal(button.purpose, 'Standard interactive button primitive for forms and actions.');
  assert.equal(button.useCases, 'Form submission, dialog confirmation, toolbar actions.');
  assert.equal(button.features, 'Variants (primary/secondary/ghost), loading state, icon support.');
  // Backticks must be stripped from location/docsPath.
  assert.equal(button.location, 'packages/ui/src/primitives/Button.tsx');
  assert.equal(button.docsPath, 'packages/ui/docs/Button.md');

  const dataGrid = byName.DataGrid;
  assert.ok(dataGrid, 'parse() must include a DataGrid item');
  assert.equal(dataGrid.location, 'packages/ui/src/data/DataGrid.tsx');
});

test('Button memory derives a raw-HTML content matcher: ["<button\\\\b"]', () => {
  const mod = require(UI_CATALOG_PATH);
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);
  const button = items.find((i) => i.name === 'Button');
  assert.ok(button, 'fixture must include Button');

  const memory = mod.toMemory(button);
  assert.ok(memory && typeof memory === 'object', 'toMemory(Button) must return an object');

  assert.equal(memory.name, 'ui-component-Button');
  assert.deepEqual(memory.events, ['PreToolUse']);
  assert.deepEqual(memory.trigger_pretool, ['Edit:.*\\.tsx', 'Write:.*\\.tsx']);
  assert.equal(memory.inject, 'full');

  // Spec-literal: raw HTML tag matcher.
  assert.deepEqual(
    memory.trigger_pretool_content,
    ['<button\\b'],
    `Button must use the raw-HTML-tag matcher per spec, got: ${JSON.stringify(memory.trigger_pretool_content)}`
  );

  assert.equal(typeof memory.body, 'string');
  assert.ok(memory.body.includes(button.purpose), 'body must include the component purpose');
  assert.ok(
    memory.body.includes('packages/ui/src/primitives/Button.tsx'),
    'body must reference the Location path'
  );
});

test('DataGrid memory derives MUI-import escape-hatch matchers', () => {
  const mod = require(UI_CATALOG_PATH);
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);
  const dataGrid = items.find((i) => i.name === 'DataGrid');
  assert.ok(dataGrid, 'fixture must include DataGrid');

  const memory = mod.toMemory(dataGrid);
  assert.ok(memory, 'toMemory(DataGrid) must return an object');
  assert.equal(memory.name, 'ui-component-DataGrid');

  const joined = memory.trigger_pretool_content.join('\n');
  assert.match(joined, /@mui\/material/, 'expected an @mui/material import matcher');
  assert.match(joined, /\\bDataGrid\\b/, 'expected a \\bDataGrid\\b import-list matcher');
});

test('Typography group (Text + Heading + Paragraph) merges into ui-component-typography', () => {
  const mod = require(UI_CATALOG_PATH);
  const driver = require(SCRIPT_PATH);
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);

  const memories = items.map((i) => mod.toMemory(i)).filter(Boolean);
  // Pre-merge: each typography component produces a memory with the sentinel.
  const preTypo = memories.filter(
    (m) =>
      Array.isArray(m.trigger_pretool_content) && m.trigger_pretool_content[0] === '__TYPOGRAPHY__'
  );
  assert.ok(
    preTypo.length >= 3,
    `expected at least 3 typography sentinel memories before merge, got ${preTypo.length}`
  );

  const merged = driver.mergeCollisions(memories);
  const typoMemories = merged.filter((m) => /typography/i.test(m.name));
  assert.equal(
    typoMemories.length,
    1,
    `expected exactly one typography memory, got ${typoMemories.length}: ${typoMemories
      .map((m) => m.name)
      .join(', ')}`
  );

  const typo = typoMemories[0];
  assert.equal(typo.name, 'ui-component-typography');
  assert.deepEqual(typo.trigger_pretool_content, ['<(p|h[1-6]|span)\\b']);
  assert.match(typo.body, /Text/);
  assert.match(typo.body, /Heading/);

  const names = merged.map((m) => m.name);
  assert.ok(!names.includes('ui-component-Text'), 'no separate ui-component-Text after merge');
  assert.ok(
    !names.includes('ui-component-Heading'),
    'no separate ui-component-Heading after merge'
  );
  assert.ok(
    !names.includes('ui-component-Paragraph'),
    'no separate ui-component-Paragraph after merge'
  );
});

test('Stub profiles (testing-guide, migrations, playwright-docker) load and emit zero memories', () => {
  for (const stub of ['testing-guide', 'migrations', 'playwright-docker']) {
    const p = path.join(PROFILES_DIR, `${stub}.js`);
    assert.ok(fs.existsSync(p), `expected stub profile at ${p}`);
    const mod = require(p);
    assert.equal(mod.name, stub);
    assert.equal(typeof mod.description, 'string');
    assert.ok(Array.isArray(mod.sources));
    assert.deepEqual(mod.parse('anything'), [], `${stub}.parse() must return []`);
    assert.equal(mod.toMemory({ name: 'X' }), null, `${stub}.toMemory() must return null`);
  }
});

test('End-to-end consolidate run produces a valid writable manifest deterministically', () => {
  assert.ok(fs.existsSync(SCRIPT_PATH), `expected driver script at ${SCRIPT_PATH}`);

  const outA = mkTmpOut('e2e-a');
  const outB = mkTmpOut('e2e-b');

  const runA = runConsolidate([`--repo=${SAMPLE_REPO}`, '--profile=ui-catalog', `--out=${outA}`]);
  assert.equal(runA.status, 0, `run A should exit 0, got ${runA.status}. stderr=${runA.stderr}`);
  assert.ok(fs.existsSync(outA), `run A should write manifest at ${outA}`);

  const rawA = fs.readFileSync(outA, 'utf8');
  const manifestA = JSON.parse(rawA);
  assert.ok(Array.isArray(manifestA.memories), 'manifest.memories must be an array');
  assert.ok(
    manifestA.memories.length > 0,
    `expected at least one memory from ui-catalog, got ${manifestA.memories.length}`
  );
  for (const mem of manifestA.memories) {
    assert.equal(typeof mem.name, 'string');
    assert.ok(mem.name.length > 0);
    assert.ok(Array.isArray(mem.events));
    assert.equal(typeof mem.body, 'string');
  }
  assert.ok(rawA.endsWith('\n'), 'manifest must end with newline');
  assert.ok(rawA.includes('\n  '), 'manifest must be pretty-printed JSON');

  const runB = runConsolidate([`--repo=${SAMPLE_REPO}`, '--profile=ui-catalog', `--out=${outB}`]);
  assert.equal(runB.status, 0, `run B should exit 0, got ${runB.status}. stderr=${runB.stderr}`);
  const rawB = fs.readFileSync(outB, 'utf8');
  assert.equal(rawB, rawA, 'two consecutive runs must produce byte-identical manifests');

  assert.ok(
    !/\b\d{13}\b/.test(rawA),
    'manifest must not embed a Date.now()-like 13-digit timestamp'
  );
  assert.ok(
    !new RegExp(`\\b${process.pid}\\b`).test(rawA),
    'manifest body must not embed the current PID'
  );

  // Sentinel must be merged away by the time the manifest is written.
  assert.ok(
    !rawA.includes('__TYPOGRAPHY__'),
    'manifest must not leak the typography sentinel — driver should have merged it'
  );

  try {
    fs.unlinkSync(outA);
  } catch (_) {
    /* ignore */
  }
  try {
    fs.unlinkSync(outB);
  } catch (_) {
    /* ignore */
  }
});

test('Unknown content-matcher collision emits a stderr warning and keeps the first', () => {
  const driver = require(SCRIPT_PATH);
  assert.equal(typeof driver.mergeCollisions, 'function');

  const memories = [
    {
      name: 'ui-component-Beta',
      events: ['PreToolUse'],
      trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
      trigger_pretool_content: ['\\bcollide\\b'],
      inject: 'full',
      body: '# Beta',
    },
    {
      name: 'ui-component-Alpha',
      events: ['PreToolUse'],
      trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
      trigger_pretool_content: ['\\bcollide\\b'],
      inject: 'full',
      body: '# Alpha',
    },
  ];

  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return originalWrite(chunk, ...rest);
  };

  let result;
  try {
    result = driver.mergeCollisions(memories);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.ok(Array.isArray(result));
  const survivors = result.filter(
    (m) => m.name === 'ui-component-Alpha' || m.name === 'ui-component-Beta'
  );
  assert.equal(survivors.length, 1, `collision must keep exactly one of Alpha/Beta`);

  assert.match(captured, /\[synapsys-consolidate\] unexpected matcher collision/);
  assert.match(captured, /ui-component-Alpha/);
  assert.match(captured, /ui-component-Beta/);
  assert.ok(
    captured.indexOf('ui-component-Alpha') < captured.indexOf('ui-component-Beta'),
    'warning must alphabetise component names'
  );
});

test('consolidate skill confirms before overwriting a manually-authored memory', () => {
  const SKILL_PATH = path.join(__dirname, '..', 'skills', 'consolidate', 'SKILL.md');
  assert.ok(fs.existsSync(SKILL_PATH), `expected consolidate skill at ${SKILL_PATH}`);

  const raw = fs.readFileSync(SKILL_PATH, 'utf8');

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'SKILL.md must start with YAML frontmatter');
  const frontmatter = fmMatch[1];
  assert.match(frontmatter, /user-invocable:\s*true/);
  assert.match(frontmatter, /allowed-tools:[^\n]*AskUserQuestion/);

  const requiredStrings = [
    'synapsys-crystallize-lint.js',
    'synapsys-crystallize-write.js',
    'synapsys-test.js',
    '--force --store=',
    'AskUserQuestion',
    '.consolidate-registry.json',
    'proceed',
    'skip-conflicts',
    'cancel',
    'delete stale',
    'would overwrite manual',
  ];
  for (const needle of requiredStrings) {
    assert.ok(raw.includes(needle), `SKILL.md must contain ${JSON.stringify(needle)}`);
  }
});

test('Missing source file is skipped with a stderr warning, not a crash', () => {
  assert.ok(fs.existsSync(SCRIPT_PATH), `expected driver script at ${SCRIPT_PATH}`);

  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-consolidate-empty-repo-'));
  const outPath = mkTmpOut('missing-source');

  const result = runConsolidate([
    `--repo=${emptyRepo}`,
    '--profile=ui-catalog',
    `--out=${outPath}`,
  ]);

  assert.ok(
    result.status === 0 || result.status === 1,
    `expected graceful exit (0 or 1), got status=${result.status} signal=${result.signal} stderr=${result.stderr}`
  );
  assert.equal(result.signal, null, 'process must not be killed by a signal');

  assert.match(result.stderr, /\[synapsys-consolidate\] source not found:/);
  assert.match(result.stderr, /\(profile: ui-catalog\)/);

  try {
    fs.unlinkSync(outPath);
  } catch (_) {
    /* ignore */
  }
  try {
    fs.rmdirSync(emptyRepo, { recursive: true });
  } catch (_) {
    /* ignore */
  }
});

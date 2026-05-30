'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT_PATH = path.join(
  __dirname,
  '..',
  'scripts',
  'synapsys-consolidate.js'
);
const SAMPLE_REPO = path.join(__dirname, 'fixtures', 'sample-repo');

function mkTmpOut(label) {
  return path.join(
    os.tmpdir(),
    `synapsys-consolidate-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
}

function runConsolidate(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
  });
}

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  'sample-repo',
  'packages',
  'ui',
  'components-catalog.md'
);

test('sample-repo components-catalog.md fixture exists and contains parseable component headings', () => {
  assert.ok(
    fs.existsSync(FIXTURE_PATH),
    `expected fixture at ${FIXTURE_PATH} to exist`
  );

  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const headings = text.split(/^### /m).slice(1);

  assert.ok(
    headings.length >= 4,
    `expected at least 4 '### ' component blocks in fixture, found ${headings.length}`
  );
});

test('Stub profiles do not crash and emit zero memories', () => {
  const stubs = ['testing-guide', 'migrations', 'playwright-docker'];
  for (const name of stubs) {
    const modPath = path.join(
      __dirname,
      '..',
      'scripts',
      'consolidate-profiles',
      `${name}.js`
    );
    assert.ok(fs.existsSync(modPath), `expected stub profile module at ${modPath}`);
    const mod = require(modPath);
    assert.equal(typeof mod.name, 'string', `${name}: exports.name must be a string`);
    assert.ok(mod.name.length > 0, `${name}: exports.name must be non-empty`);
    assert.equal(typeof mod.description, 'string', `${name}: exports.description must be a string`);
    assert.ok(Array.isArray(mod.sources), `${name}: exports.sources must be an array`);
    assert.equal(typeof mod.parse, 'function', `${name}: exports.parse must be a function`);
    assert.equal(typeof mod.toMemory, 'function', `${name}: exports.toMemory must be a function`);
    const parsed = mod.parse('', 'irrelevant.md');
    assert.deepEqual(parsed, [], `${name}: parse('') must return []`);
    const memory = mod.toMemory({}, {});
    assert.equal(memory, null, `${name}: toMemory({}, {}) must return null`);
  }
});

test('ui-catalog profile parses a catalog markdown into atomic items', () => {
  const modPath = path.join(
    __dirname,
    '..',
    'scripts',
    'consolidate-profiles',
    'ui-catalog.js'
  );
  assert.ok(fs.existsSync(modPath), `expected ui-catalog profile at ${modPath}`);
  const mod = require(modPath);

  assert.equal(mod.name, 'ui-catalog', 'exports.name must be "ui-catalog"');
  assert.equal(typeof mod.description, 'string', 'exports.description must be a string');
  assert.deepEqual(
    mod.sources,
    ['packages/ui/components-catalog.md'],
    'exports.sources must list components-catalog.md path'
  );
  assert.equal(typeof mod.parse, 'function', 'exports.parse must be a function');
  assert.equal(typeof mod.toMemory, 'function', 'exports.toMemory must be a function');

  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);

  assert.ok(Array.isArray(items), 'parse() must return an array');
  // Fixture has 7 component blocks (Button, DataGrid, Text, Heading, Paragraph, Alpha, Beta).
  assert.ok(
    items.length >= 4,
    `expected at least 4 parsed items, got ${items.length}`
  );

  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  const button = byName.Button;
  assert.ok(button, 'parse() must include a Button item');
  assert.equal(button.name, 'Button');
  assert.equal(
    button.purpose,
    'Standard interactive button primitive for forms and actions.'
  );
  assert.equal(
    button.useCases,
    'Form submission, dialog confirmation, toolbar actions.'
  );
  assert.equal(
    button.features,
    'Variants (primary/secondary/ghost), loading state, icon support.'
  );
  // Backticks must be stripped from location/docsPath.
  assert.equal(button.location, 'packages/ui/src/primitives/Button.tsx');
  assert.equal(button.docsPath, 'packages/ui/docs/Button.md');

  const dataGrid = byName.DataGrid;
  assert.ok(dataGrid, 'parse() must include a DataGrid item');
  assert.equal(dataGrid.location, 'packages/ui/src/data/DataGrid.tsx');

  // toMemory is a Task-4 deliverable; in this task it stays a null placeholder.
  // (Task 4 promotes this to a real memory — see the Button/DataGrid tests below.)
});

test('Button component derives a raw-HTML content matcher', () => {
  const mod = require(path.join(
    __dirname,
    '..',
    'scripts',
    'consolidate-profiles',
    'ui-catalog.js'
  ));
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);
  const button = items.find((i) => i.name === 'Button');
  assert.ok(button, 'fixture must include Button');

  const memory = mod.toMemory(button, {});
  assert.ok(memory && typeof memory === 'object', 'toMemory(Button) must return an object');

  assert.equal(memory.name, 'ui-component-Button', 'memory.name');
  assert.deepEqual(memory.events, ['PreToolUse'], 'memory.events');
  assert.deepEqual(
    memory.trigger_pretool,
    ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
    'memory.trigger_pretool'
  );
  assert.deepEqual(
    memory.trigger_pretool_content,
    ['<button\\b'],
    'memory.trigger_pretool_content must be raw-HTML <button\\b matcher'
  );
  assert.equal(memory.inject, 'full', 'memory.inject');

  assert.equal(typeof memory.body, 'string', 'memory.body must be a string');
  assert.ok(
    memory.body.includes(button.purpose),
    'body must include the component purpose'
  );
  assert.ok(
    memory.body.includes('packages/ui/src/primitives/Button.tsx'),
    'body must reference the Location path'
  );
});

test('DataGrid derives MUI-import escape-hatch matcher (no raw HTML primitive)', () => {
  const mod = require(path.join(
    __dirname,
    '..',
    'scripts',
    'consolidate-profiles',
    'ui-catalog.js'
  ));
  const text = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const items = mod.parse(text, FIXTURE_PATH);
  const dataGrid = items.find((i) => i.name === 'DataGrid');
  assert.ok(dataGrid, 'fixture must include DataGrid');

  const memory = mod.toMemory(dataGrid, {});
  assert.ok(memory && typeof memory === 'object', 'toMemory(DataGrid) must return an object');

  assert.equal(memory.name, 'ui-component-DataGrid', 'memory.name');
  assert.ok(
    Array.isArray(memory.trigger_pretool_content),
    'trigger_pretool_content must be an array'
  );
  const joined = memory.trigger_pretool_content.join('\n');
  assert.ok(
    /@mui\/material/.test(joined),
    `expected an @mui/material pattern, got ${joined}`
  );
  assert.ok(
    /\\bDataGrid\\b/.test(joined),
    `expected a \\bDataGrid\\b pattern, got ${joined}`
  );
  // Escape-hatch path must NOT emit a raw HTML primitive matcher.
  assert.ok(
    !memory.trigger_pretool_content.some((p) => /^<[a-z]/.test(p)),
    'DataGrid must not derive a raw-HTML primitive matcher'
  );
});

test('End-to-end consolidate run produces a valid writable manifest deterministically', () => {
  assert.ok(
    fs.existsSync(SCRIPT_PATH),
    `expected driver script at ${SCRIPT_PATH}`
  );

  const outA = mkTmpOut('e2e-a');
  const outB = mkTmpOut('e2e-b');

  const runA = runConsolidate([
    `--repo=${SAMPLE_REPO}`,
    '--profile=ui-catalog',
    `--out=${outA}`,
  ]);
  assert.equal(
    runA.status,
    0,
    `run A should exit 0, got ${runA.status}. stderr=${runA.stderr}`
  );
  assert.ok(fs.existsSync(outA), `run A should write manifest at ${outA}`);

  const rawA = fs.readFileSync(outA, 'utf8');
  // Must be valid JSON.
  const manifestA = JSON.parse(rawA);
  assert.ok(
    Array.isArray(manifestA.memories),
    'manifest.memories must be an array'
  );
  assert.ok(
    manifestA.memories.length > 0,
    `expected at least one memory from ui-catalog, got ${manifestA.memories.length}`
  );
  for (const mem of manifestA.memories) {
    assert.equal(typeof mem.name, 'string', 'each memory.name must be a string');
    assert.ok(mem.name.length > 0, 'memory.name must be non-empty');
    assert.ok(Array.isArray(mem.events), 'memory.events must be an array');
    assert.equal(typeof mem.body, 'string', 'memory.body must be a string');
  }
  // Pretty-printed with trailing newline (writer-compatible shape).
  assert.ok(rawA.endsWith('\n'), 'manifest must end with newline');
  assert.ok(rawA.includes('\n  '), 'manifest must be pretty-printed JSON');

  // Determinism: a second run with identical inputs must be byte-identical.
  const runB = runConsolidate([
    `--repo=${SAMPLE_REPO}`,
    '--profile=ui-catalog',
    `--out=${outB}`,
  ]);
  assert.equal(
    runB.status,
    0,
    `run B should exit 0, got ${runB.status}. stderr=${runB.stderr}`
  );
  const rawB = fs.readFileSync(outB, 'utf8');
  assert.equal(rawB, rawA, 'two consecutive runs must produce byte-identical manifests');

  // Manifest body must not embed non-deterministic values like Date.now or PIDs.
  assert.ok(
    !/\b\d{13}\b/.test(rawA),
    'manifest must not embed a Date.now()-like 13-digit timestamp'
  );
  assert.ok(
    !new RegExp(`\\b${process.pid}\\b`).test(rawA),
    'manifest body must not embed the current PID'
  );

  // Cleanup.
  try { fs.unlinkSync(outA); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(outB); } catch (_) { /* ignore */ }
});

test('Typography group (Text + Heading + Paragraph) merges into one memory', () => {
  assert.ok(
    fs.existsSync(SCRIPT_PATH),
    `expected driver script at ${SCRIPT_PATH}`
  );

  const outPath = mkTmpOut('typography-merge');
  const result = runConsolidate([
    `--repo=${SAMPLE_REPO}`,
    '--profile=ui-catalog',
    `--out=${outPath}`,
  ]);

  assert.equal(
    result.status,
    0,
    `expected exit 0, got ${result.status}. stderr=${result.stderr}`
  );
  assert.ok(fs.existsSync(outPath), `expected manifest at ${outPath}`);

  const manifest = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const byName = Object.fromEntries(
    manifest.memories.map((m) => [m.name, m])
  );

  // No per-typography-component memory should be emitted.
  assert.ok(
    !byName['ui-component-Text'],
    'ui-component-Text must not be emitted (merged into typography)'
  );
  assert.ok(
    !byName['ui-component-Heading'],
    'ui-component-Heading must not be emitted (merged into typography)'
  );
  assert.ok(
    !byName['ui-component-Paragraph'],
    'ui-component-Paragraph must not be emitted (merged into typography)'
  );

  // A single merged typography memory must be present.
  const merged = byName['ui-component-typography'];
  assert.ok(
    merged,
    `expected merged ui-component-typography memory; got names=${Object.keys(byName).join(',')}`
  );
  assert.deepEqual(
    merged.trigger_pretool_content,
    ['<(p|h[1-6]|span)\\b'],
    'merged typography memory must use the canonical <(p|h[1-6]|span)\\b matcher'
  );
  assert.ok(
    merged.body.includes('Text'),
    'merged body must mention Text component'
  );
  assert.ok(
    merged.body.includes('Heading'),
    'merged body must mention Heading component'
  );
  assert.ok(
    merged.body.includes('Paragraph'),
    'merged body must mention Paragraph component'
  );

  try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
});

test('Unknown content-matcher collision emits a stdout warning', () => {
  // Unit-test the driver's pure mergeCollisions(memories) helper directly:
  // construct two non-typography memories with identical trigger_pretool_content
  // and assert the driver warns naming BOTH components, keeps the first, drops
  // the rest. The driver script must export mergeCollisions for this test.
  const driver = require(SCRIPT_PATH);
  assert.equal(
    typeof driver.mergeCollisions,
    'function',
    'synapsys-consolidate.js must export a mergeCollisions(memories) helper'
  );

  const memories = [
    {
      name: 'ui-component-Beta',
      events: ['PreToolUse'],
      trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
      trigger_pretool_content: ['<collide\\b'],
      inject: 'full',
      body: '# Beta',
    },
    {
      name: 'ui-component-Alpha',
      events: ['PreToolUse'],
      trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
      trigger_pretool_content: ['<collide\\b'],
      inject: 'full',
      body: '# Alpha',
    },
  ];

  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString();
    return originalWrite(chunk, ...rest);
  };

  let result;
  try {
    result = driver.mergeCollisions(memories);
  } finally {
    process.stdout.write = originalWrite;
  }

  // First kept, rest dropped — exactly one memory survives the collision.
  assert.ok(Array.isArray(result), 'mergeCollisions must return an array');
  const collidedSurvivors = result.filter(
    (m) => m.name === 'ui-component-Alpha' || m.name === 'ui-component-Beta'
  );
  assert.equal(
    collidedSurvivors.length,
    1,
    `collision must keep exactly one of Alpha/Beta, got ${collidedSurvivors.length}`
  );

  // Warning must name BOTH colliding components (alphabetised) on stdout.
  assert.match(
    captured,
    /\[synapsys-consolidate\] unexpected matcher collision/,
    `expected stdout warning prefix, got: ${captured}`
  );
  assert.match(
    captured,
    /ui-component-Alpha/,
    `warning must name Alpha, got: ${captured}`
  );
  assert.match(
    captured,
    /ui-component-Beta/,
    `warning must name Beta, got: ${captured}`
  );
  // Alpha must appear before Beta (alphabetised ordering).
  assert.ok(
    captured.indexOf('ui-component-Alpha') < captured.indexOf('ui-component-Beta'),
    `warning must alphabetise component names (Alpha before Beta), got: ${captured}`
  );
});

test('consolidate skill confirms before overwriting a manually-authored memory', () => {
  // Skill contract test: asserts the SKILL.md file exists, has the required
  // frontmatter (user-invocable + AskUserQuestion in allowed-tools), and its
  // body documents the 11-step orchestration including the manual-overwrite
  // confirmation gate, sidecar registry path, stale-delete gate, and the
  // proceed/skip-conflicts/cancel option set.
  const SKILL_PATH = path.join(
    __dirname,
    '..',
    'skills',
    'consolidate',
    'SKILL.md'
  );

  assert.ok(
    fs.existsSync(SKILL_PATH),
    `expected consolidate skill at ${SKILL_PATH}`
  );

  const raw = fs.readFileSync(SKILL_PATH, 'utf8');

  // Frontmatter must declare user-invocable: true and include AskUserQuestion
  // in allowed-tools.
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'SKILL.md must start with YAML frontmatter');
  const frontmatter = fmMatch[1];
  assert.match(
    frontmatter,
    /user-invocable:\s*true/,
    `frontmatter must declare user-invocable: true, got:\n${frontmatter}`
  );
  assert.match(
    frontmatter,
    /allowed-tools:[^\n]*AskUserQuestion/,
    `allowed-tools must include AskUserQuestion, got:\n${frontmatter}`
  );

  // Body must reference the sibling scripts the skill orchestrates,
  // the writer's --force --store= invocation, the AskUserQuestion gate,
  // the sidecar registry, the option labels (proceed/skip-conflicts/cancel),
  // the stale-delete gate, and the manual-overwrite confirmation phrase.
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
    assert.ok(
      raw.includes(needle),
      `SKILL.md body must contain the literal string ${JSON.stringify(needle)}`
    );
  }
});

test('Missing source file is skipped with a stderr warning, not a crash', () => {
  assert.ok(
    fs.existsSync(SCRIPT_PATH),
    `expected driver script at ${SCRIPT_PATH}`
  );

  // Use an empty temp directory as --repo so ui-catalog's source path
  // (packages/ui/components-catalog.md) resolves to a non-existent file.
  const emptyRepo = fs.mkdtempSync(
    path.join(os.tmpdir(), 'synapsys-consolidate-empty-repo-')
  );
  const outPath = mkTmpOut('missing-source');

  const result = runConsolidate([
    `--repo=${emptyRepo}`,
    '--profile=ui-catalog',
    '--profile=testing-guide',
    `--out=${outPath}`,
  ]);

  // Must NOT crash on missing source — exit code is 0 (success) or 1
  // (zero memories), never a non-zero crash code like 2+ or a signal.
  assert.ok(
    result.status === 0 || result.status === 1,
    `expected graceful exit (0 or 1), got status=${result.status} signal=${result.signal} stderr=${result.stderr}`
  );
  assert.equal(result.signal, null, 'process must not be killed by a signal');

  // Warning must be on stderr, in the documented format.
  assert.match(
    result.stderr,
    /\[synapsys-consolidate\] source not found:/,
    `expected stderr to contain "[synapsys-consolidate] source not found:", got: ${result.stderr}`
  );
  assert.match(
    result.stderr,
    /\(profile: ui-catalog\)/,
    `expected stderr to attribute missing source to "ui-catalog" profile, got: ${result.stderr}`
  );

  // Cleanup.
  try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
  try { fs.rmdirSync(emptyRepo, { recursive: true }); } catch (_) { /* ignore */ }
});

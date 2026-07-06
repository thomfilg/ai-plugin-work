'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expandGlob, scanVar, scanFulfillable } = require('../scan');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envcfg-scan-'));
  fs.mkdirSync(path.join(tmp, '.rulesync', 'rules'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.rulesync', 'subagents'), { recursive: true });
  for (const name of ['code-quality.md', 'types.md', 'e2e-testing.md', 'testing.local.md']) {
    fs.writeFileSync(path.join(tmp, '.rulesync', 'rules', name), `# ${name}\n`);
  }
  fs.writeFileSync(path.join(tmp, '.rulesync', 'subagents', 'qa.md'), '# qa\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('expandGlob matches basename wildcards and exact paths', () => {
  assert.deepEqual(expandGlob(tmp, '.rulesync/rules/*.md'), [
    '.rulesync/rules/code-quality.md',
    '.rulesync/rules/e2e-testing.md',
    '.rulesync/rules/testing.local.md',
    '.rulesync/rules/types.md',
  ]);
  assert.deepEqual(expandGlob(tmp, '.rulesync/subagents/qa.md'), ['.rulesync/subagents/qa.md']);
  assert.deepEqual(expandGlob(tmp, 'docs/*.md'), []);
  assert.deepEqual(expandGlob(tmp, 'docs/ARCH.md'), []);
});

test('scanVar filters suggestions by names, keeps all candidates', () => {
  const def = {
    scan: {
      globs: ['.rulesync/rules/*.md', '.rulesync/subagents/qa.md'],
      names: ['e2e-testing', 'testing.local', 'qa'],
    },
  };
  const result = scanVar(tmp, def);
  assert.equal(result.candidates.length, 5);
  assert.deepEqual(result.suggested, [
    '.rulesync/rules/e2e-testing.md',
    '.rulesync/rules/testing.local.md',
    '.rulesync/subagents/qa.md',
  ]);
  assert.equal(scanVar(tmp, { scan: { globs: ['nowhere/*.md'] } }), null);
  assert.equal(scanVar(tmp, {}), null);
});

const schema = {
  plugin: 'demo',
  prefixes: ['READ_DOCS_'],
  vars: {
    READ_DOCS_A: {
      type: 'string',
      default: '',
      description: 'a',
      section: 'Docs',
      advanced: true,
      scan: { globs: ['.rulesync/rules/*.md'], names: ['types', 'code-quality'] },
    },
    READ_DOCS_B: {
      type: 'string',
      default: '',
      description: 'b',
      section: 'Docs',
      advanced: true,
      scan: { globs: ['docs/*.md'] },
    },
    PLAIN_VAR: { type: 'string', default: '', description: 'p', section: 'Core' },
  },
};

test('scanFulfillable proposes CSV values for unset scannable vars only', () => {
  const out = scanFulfillable({ schema, projectRoot: tmp, values: {} });
  assert.equal(out.length, 1, 'B has no matches, PLAIN_VAR has no scan block');
  assert.equal(out[0].name, 'READ_DOCS_A');
  assert.equal(out[0].value, '.rulesync/rules/code-quality.md,.rulesync/rules/types.md');
});

test('scanFulfillable skips set and acknowledged vars', () => {
  const set = scanFulfillable({
    schema,
    projectRoot: tmp,
    values: { READ_DOCS_A: { value: 'x.md', dynamic: false, source: 'envrc' } },
  });
  assert.deepEqual(set, []);
  const acked = scanFulfillable({
    schema,
    projectRoot: tmp,
    values: {},
    acknowledged: new Set(['READ_DOCS_A']),
  });
  assert.deepEqual(acked, []);
  // Empty-string value still counts as unset — that's the nag the user asked for.
  const empty = scanFulfillable({
    schema,
    projectRoot: tmp,
    values: { READ_DOCS_A: { value: '', dynamic: false, source: 'envrc' } },
  });
  assert.equal(empty.length, 1);
});

test('work schema: READ_DOCS scan blocks resolve against a .rulesync fixture', () => {
  const workSchema = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'plugins', 'work', 'config-schema.json'),
      'utf8'
    )
  );
  const out = scanFulfillable({ schema: workSchema, projectRoot: tmp, values: {} });
  const byName = Object.fromEntries(out.map((entry) => [entry.name, entry.value]));
  assert.match(byName.READ_DOCS_ON_REVIEW, /code-quality\.md/);
  assert.match(byName.READ_DOCS_ON_QA, /qa\.md/);
  assert.match(byName.READ_DOCS_ON_TEST, /types\.md/);
  assert.ok(!byName.READ_DOCS_ON_TEST.includes('e2e-testing'), 'TEST excludes e2e docs');
});

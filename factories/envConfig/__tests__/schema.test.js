'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadSchema,
  validateSchemaShape,
  schemaHash,
  mergeSchemas,
  discoverSchemas,
  findMarketplaceRoot,
} = require('../schema');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function minimalSchema(overrides = {}) {
  return {
    plugin: 'demo',
    prefixes: ['DEMO_'],
    vars: {
      DEMO_FLAG: { type: 'bool01', default: '0', description: 'a flag', section: 'Flags' },
    },
    ...overrides,
  };
}

test('validateSchemaShape accepts a minimal schema', () => {
  assert.equal(validateSchemaShape(minimalSchema()).plugin, 'demo');
});

test('validateSchemaShape rejects bad shapes precisely', () => {
  assert.throws(() => validateSchemaShape({}), /missing "plugin"/);
  assert.throws(() => validateSchemaShape(minimalSchema({ prefixes: null })), /prefixes/);
  assert.throws(
    () =>
      validateSchemaShape(
        minimalSchema({ vars: { BAD: { type: 'nope', description: 'x', section: 's' } } })
      ),
    /unknown type/
  );
  assert.throws(
    () =>
      validateSchemaShape(
        minimalSchema({ vars: { X_ENUM: { type: 'enum', description: 'x', section: 's' } } })
      ),
    /values/
  );
});

test('loadSchema returns null for a missing file', () => {
  assert.equal(loadSchema(path.join(os.tmpdir(), 'no-such-schema.json')), null);
});

test('schemaHash is stable under key reordering', () => {
  const a = minimalSchema();
  const b = {
    vars: { DEMO_FLAG: { section: 'Flags', description: 'a flag', default: '0', type: 'bool01' } },
    prefixes: ['DEMO_'],
    plugin: 'demo',
  };
  assert.equal(schemaHash(a), schemaHash(b));
  const c = minimalSchema();
  c.vars.DEMO_NEW = { type: 'string', default: '', description: 'new', section: 'Flags' };
  assert.notEqual(schemaHash(a), schemaHash(c));
});

test('mergeSchemas unions prefixes/internal, first declaration wins', () => {
  const a = minimalSchema({ internal: ['DEMO_RUNTIME'] });
  const b = minimalSchema({ plugin: 'other', prefixes: ['OTHER_'] });
  b.vars = {
    DEMO_FLAG: { type: 'string', default: 'x', description: 'conflict', section: 'S' },
    OTHER_VAR: { type: 'string', default: '', description: 'other', section: 'S' },
  };
  const merged = mergeSchemas([a, b]);
  assert.deepEqual(merged.plugins, ['demo', 'other']);
  assert.deepEqual(merged.prefixes, ['DEMO_', 'OTHER_']);
  assert.ok(merged.internal.has('DEMO_RUNTIME'));
  assert.equal(merged.vars.DEMO_FLAG.type, 'bool01');
  assert.equal(merged.varPlugin.OTHER_VAR, 'other');
});

test('self-test: every marketplace plugin ships a valid schema', () => {
  const schemas = discoverSchemas(REPO_ROOT);
  const names = schemas.map((s) => s.plugin);
  // Subset assertion: a future fifth plugin must not break this test.
  for (const plugin of ['heimdall', 'maestro', 'synapsys', 'work-workflow']) {
    assert.ok(names.includes(plugin), `missing schema for ${plugin}`);
  }
});

test('findMarketplaceRoot walks up from a plugin dir', () => {
  assert.equal(findMarketplaceRoot(path.join(REPO_ROOT, 'plugins', 'work', 'hooks')), REPO_ROOT);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envcfg-'));
  try {
    assert.equal(findMarketplaceRoot(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

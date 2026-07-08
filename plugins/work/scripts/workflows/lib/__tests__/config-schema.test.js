'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Lazy-load so a not-yet-authored module surfaces as a per-test assertion
// failure (a behavior gap) rather than a collection-time crash that aborts the
// whole suite. Each test resolves the module through this helper.
function loadSchemaModule() {
  let mod;
  assert.doesNotThrow(() => {
    mod = require('../config-schema');
  }, 'config-schema module loads');
  return mod;
}

// The set of recognized `type` values the descriptor map may declare.
const VALID_TYPES = new Set(['flag01', 'bool', 'enum', 'json-array', 'string']);

// A representative subset of the keys `config.js` reads. The schema must cover
// every one of these; the assertions below are a spot-check, not an exhaustive
// mirror of config.js (which would duplicate its resolution logic — forbidden).
const REQUIRED_PREFIXED_KEYS = [
  'ENABLE_SYMLINK',
  'WORK_TEST_STRATEGY_VALIDATOR',
  'TICKET_PROVIDER',
  'TICKET_PROJECT_KEY',
];

const REQUIRED_NON_PREFIXED_KEYS = [
  'WEB_APPS',
  'FOLLOW_UP_PR_POLL_REVIEWS',
  'READ_DOCS_ON_REVIEW',
  'BASE_BRANCH',
  'TEST_COMMAND',
  'SCRIPT_RUN_AFFECTED_UNIT',
];

describe('config-schema module', () => {
  it('exports SCHEMA, KNOWN_KEYS, and PREFIXES', () => {
    const schemaModule = loadSchemaModule();
    assert.ok(schemaModule.SCHEMA, 'SCHEMA export is present');
    assert.ok(schemaModule.KNOWN_KEYS, 'KNOWN_KEYS export is present');
    assert.ok(schemaModule.PREFIXES, 'PREFIXES export is present');
  });

  it('exposes PREFIXES as the three known prefixes', () => {
    const schemaModule = loadSchemaModule();
    assert.deepEqual(schemaModule.PREFIXES, ['WORK_', 'ENABLE_', 'TICKET_']);
  });

  it('derives KNOWN_KEYS from Object.keys(SCHEMA)', () => {
    const schemaModule = loadSchemaModule();
    assert.deepEqual(schemaModule.KNOWN_KEYS, Object.keys(schemaModule.SCHEMA));
  });

  it('freezes the SCHEMA object', () => {
    const schemaModule = loadSchemaModule();
    assert.ok(Object.isFrozen(schemaModule.SCHEMA), 'SCHEMA is frozen');
    assert.throws(() => {
      schemaModule.SCHEMA.__SOME_NEW_KEY__ = { type: 'string' };
    }, 'cannot add new keys to a frozen schema in strict mode');
  });

  it('gives every entry a recognized type and well-formed shape', () => {
    const schemaModule = loadSchemaModule();
    for (const [key, entry] of Object.entries(schemaModule.SCHEMA)) {
      assert.ok(entry && typeof entry === 'object', `${key} entry is an object`);
      assert.ok(VALID_TYPES.has(entry.type), `${key} has a recognized type: ${entry.type}`);
      if ('allowed' in entry) {
        assert.ok(Array.isArray(entry.allowed), `${key}.allowed is an array`);
      }
      if (entry.type === 'enum') {
        assert.ok(
          Array.isArray(entry.allowed) && entry.allowed.length > 0,
          `${key} enum entry declares a non-empty allowed list`,
        );
      }
    }
  });

  it('uses every supported type at least once across the schema', () => {
    const schemaModule = loadSchemaModule();
    const usedTypes = new Set(
      Object.values(schemaModule.SCHEMA).map((entry) => entry.type),
    );
    for (const t of VALID_TYPES) {
      assert.ok(usedTypes.has(t), `type "${t}" appears in the schema`);
    }
  });

  it('covers the prefixed config keys read by config.js', () => {
    const schemaModule = loadSchemaModule();
    for (const key of REQUIRED_PREFIXED_KEYS) {
      assert.ok(key in schemaModule.SCHEMA, `${key} is in the schema`);
    }
  });

  it('covers the non-prefixed config keys read by config.js', () => {
    const schemaModule = loadSchemaModule();
    for (const key of REQUIRED_NON_PREFIXED_KEYS) {
      assert.ok(key in schemaModule.SCHEMA, `${key} is in the schema`);
    }
  });

  it('declares the expected types for representative keys', () => {
    const schemaModule = loadSchemaModule();
    assert.equal(schemaModule.SCHEMA.ENABLE_SYMLINK.type, 'flag01');
    assert.equal(schemaModule.SCHEMA.WORK_TEST_STRATEGY_VALIDATOR.type, 'flag01');
    assert.equal(schemaModule.SCHEMA.WEB_APPS.type, 'json-array');
    assert.equal(schemaModule.SCHEMA.FOLLOW_UP_PR_POLL_REVIEWS.type, 'bool');
    assert.equal(schemaModule.SCHEMA.BASE_BRANCH.type, 'string');
    assert.equal(schemaModule.SCHEMA.TICKET_PROVIDER.type, 'enum');
  });

  it('adding a single SCHEMA entry is the only edit needed to extend coverage (R10)', () => {
    const schemaModule = loadSchemaModule();
    // The descriptor map is the single source of truth: KNOWN_KEYS is derived
    // from it, so any new entry is automatically reflected without a second edit.
    const keysFromSchema = Object.keys(schemaModule.SCHEMA);
    assert.ok(keysFromSchema.length > 0, 'schema is non-empty');
    assert.deepEqual(
      new Set(schemaModule.KNOWN_KEYS),
      new Set(keysFromSchema),
      'KNOWN_KEYS mirrors SCHEMA keys with no separate maintenance list',
    );
  });
});

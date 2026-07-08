'use strict';

/**
 * GH-680 — the conductor-economics env vars (CONDUCT_WAKE_EVENTS,
 * HEARTBEAT_MIN, HEARTBEAT_MAX_MIN, PENDING_REWAKE_MIN,
 * PENDING_REWAKE_MAX_MIN) must be declared in
 * plugins/maestro/config-schema.json so `maestro:configure` renders them with
 * their defaults and the SessionStart unknown-key scan never flags them.
 * These tests pin that wiring against the shared envConfig factory (the same
 * loader/validator config-cli.js drives), and pin the schema's
 * CONDUCT_WAKE_EVENTS default to the EXACT DEFAULT_WAKE_KINDS set in
 * alerts.js — the schema copy is load-bearing (configure writes it into
 * .envrc, which then overrides the code default).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadSchema, mergeSchemas } = require('../../../../factories/envConfig/schema');
const { findUnknownKeys } = require('../../../../factories/envConfig/validate');
const { renderPluginSections } = require('../../../../factories/envConfig/render');
const { DEFAULT_WAKE_KINDS } = require('../lib/maestro-conduct/alerts');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config-schema.json');

const NEW_VARS = [
  'CONDUCT_WAKE_EVENTS',
  'HEARTBEAT_MIN',
  'HEARTBEAT_MAX_MIN',
  'PENDING_REWAKE_MIN',
  'PENDING_REWAKE_MAX_MIN',
];

test('config-schema declares the conductor tuning vars with full metadata', () => {
  const schema = loadSchema(SCHEMA_PATH);
  assert.ok(schema, 'maestro config-schema.json should load');

  for (const name of NEW_VARS) {
    const def = schema.vars[name];
    assert.ok(def, `${name} should be declared in config-schema.json vars`);
    assert.equal(typeof def.type, 'string', `${name} needs a type`);
    assert.ok(def.type.length > 0, `${name} type must be non-empty`);
    assert.equal(typeof def.description, 'string', `${name} needs a description`);
    assert.ok(def.description.length > 0, `${name} description must be non-empty`);
    assert.equal(def.section, 'Conductor Tuning', `${name} belongs in the Conductor Tuning section`);
    assert.ok('default' in def, `${name} needs a declared default`);
  }
});

test('config-schema defaults match the code defaults', () => {
  const schema = loadSchema(SCHEMA_PATH);

  assert.equal(schema.vars.HEARTBEAT_MIN.type, 'number');
  assert.equal(schema.vars.HEARTBEAT_MIN.default, '30');

  assert.equal(schema.vars.HEARTBEAT_MAX_MIN.type, 'number');
  assert.equal(schema.vars.HEARTBEAT_MAX_MIN.default, '120');

  assert.equal(schema.vars.PENDING_REWAKE_MIN.type, 'number');
  assert.equal(schema.vars.PENDING_REWAKE_MIN.default, '30');

  assert.equal(schema.vars.PENDING_REWAKE_MAX_MIN.type, 'number');
  assert.equal(schema.vars.PENDING_REWAKE_MAX_MIN.default, '240');

  assert.equal(schema.vars.CONDUCT_WAKE_EVENTS.type, 'string');
  // EXACT set equality with alerts.js DEFAULT_WAKE_KINDS — inclusion-only
  // checks would let a dropped kind regress silently (the schema copy is the
  // one operators actually get via .envrc).
  const schemaKinds = schema.vars.CONDUCT_WAKE_EVENTS.default
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  assert.deepEqual(
    [...schemaKinds].sort(),
    [...DEFAULT_WAKE_KINDS].sort(),
    'CONDUCT_WAKE_EVENTS schema default must equal alerts.js DEFAULT_WAKE_KINDS exactly'
  );
});

test('the unknown-key scan does not flag the new vars', () => {
  const schema = loadSchema(SCHEMA_PATH);
  const merged = mergeSchemas([schema]);

  const values = Object.fromEntries(
    NEW_VARS.map((name) => [name, { value: 'x', dynamic: false, source: 'env-file' }])
  );
  const unknown = findUnknownKeys(merged, values);
  const flagged = unknown.map((u) => u.name);
  for (const name of NEW_VARS) {
    assert.ok(!flagged.includes(name), `${name} must not be reported as an unknown env key`);
  }
});

test('maestro configure renders the vars under Conductor Tuning', () => {
  const schema = loadSchema(SCHEMA_PATH);
  const rendered = renderPluginSections(schema, {}).join('\n');

  assert.match(rendered, /Conductor Tuning/);
  for (const name of NEW_VARS) {
    assert.ok(rendered.includes(name), `${name} should appear in the rendered configure output`);
  }
});

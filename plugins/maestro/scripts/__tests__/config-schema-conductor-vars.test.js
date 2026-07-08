'use strict';

/**
 * Task 3 (GH-680) — the three conductor-economics env vars introduced in
 * Task 1 (CONDUCT_WAKE_EVENTS, HEARTBEAT_MIN, HEARTBEAT_MAX_MIN) must be
 * declared in plugins/maestro/config-schema.json so `maestro:configure`
 * renders them with their defaults and the SessionStart unknown-key scan
 * never flags them. These tests pin that wiring against the shared
 * envConfig factory (the same loader/validator config-cli.js drives).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadSchema, mergeSchemas } = require('../../../../factories/envConfig/schema');
const { findUnknownKeys } = require('../../../../factories/envConfig/validate');
const { renderPluginSections } = require('../../../../factories/envConfig/render');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config-schema.json');

// Default wake allowlist mirrors ACTION_REQUIRED_KINDS in alerts.js.
const ACTIONABLE_KINDS = [
  'question-pending',
  'nudges-exhausted',
  'wedged',
  'dead-end',
  'dead-end-probe',
  'pr-ready',
  'pr-broken',
  'pr-comments-stuck',
  'comment-loop',
  'stuck-input',
  'auth-broken',
];

const NEW_VARS = ['CONDUCT_WAKE_EVENTS', 'HEARTBEAT_MIN', 'HEARTBEAT_MAX_MIN'];

test('config-schema declares the three conductor tuning vars with full metadata', () => {
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

test('config-schema defaults match the Task 1 code defaults', () => {
  const schema = loadSchema(SCHEMA_PATH);

  assert.equal(schema.vars.HEARTBEAT_MIN.type, 'number');
  assert.equal(schema.vars.HEARTBEAT_MIN.default, '30');

  assert.equal(schema.vars.HEARTBEAT_MAX_MIN.type, 'number');
  assert.equal(schema.vars.HEARTBEAT_MAX_MIN.default, '120');

  assert.equal(schema.vars.CONDUCT_WAKE_EVENTS.type, 'string');
  const wakeDefault = schema.vars.CONDUCT_WAKE_EVENTS.default;
  for (const kind of ACTIONABLE_KINDS) {
    assert.ok(
      wakeDefault.includes(kind),
      `CONDUCT_WAKE_EVENTS default should list the actionable kind "${kind}"`
    );
  }
});

test('the unknown-key scan does not flag the three new vars', () => {
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

test('maestro configure renders the three vars under Conductor Tuning', () => {
  const schema = loadSchema(SCHEMA_PATH);
  const rendered = renderPluginSections(schema, {}).join('\n');

  assert.match(rendered, /Conductor Tuning/);
  for (const name of NEW_VARS) {
    assert.ok(rendered.includes(name), `${name} should appear in the rendered configure output`);
  }
});

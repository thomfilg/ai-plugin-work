'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TASK_TYPES,
  TDD_REQUIRED_TYPES,
  TDD_EXEMPT_TYPES,
  isTddRequired,
  isTddExempt,
  isKnownTaskType,
  allTaskTypes,
  gateContractFor,
} = require('../lib/task-types');

test('TASK_TYPES is frozen', () => {
  assert.equal(Object.isFrozen(TASK_TYPES), true);
});

test('TDD-required vs exempt partition is complete and disjoint', () => {
  const all = new Set(allTaskTypes());
  const req = new Set(TDD_REQUIRED_TYPES);
  const ex = new Set(TDD_EXEMPT_TYPES);
  // partition: union == all, intersection empty
  for (const t of req) assert.equal(all.has(t), true, `required type ${t} missing from all`);
  for (const t of ex) assert.equal(all.has(t), true, `exempt type ${t} missing from all`);
  for (const t of req) assert.equal(ex.has(t), false, `${t} appears in both`);
  assert.equal(req.size + ex.size, all.size, 'partition mismatch');
});

test('tdd-code is required; docs/tests-only/config/ci/etc are exempt', () => {
  assert.equal(isTddRequired('tdd-code'), true);
  assert.equal(isTddRequired('docs'), false);
  assert.equal(isTddExempt('docs'), true);
  assert.equal(isTddExempt('tests-only'), true);
  assert.equal(isTddExempt('config'), true);
  assert.equal(isTddExempt('ci'), true);
  assert.equal(isTddExempt('mechanical-refactor'), true);
  assert.equal(isTddExempt('file-move'), true);
  assert.equal(isTddExempt('checkpoint'), true);
});

test('unknown types are neither required nor exempt; isKnownTaskType=false', () => {
  assert.equal(isKnownTaskType('wiring'), false);
  assert.equal(isKnownTaskType('feature'), false);
  assert.equal(isTddRequired('wiring'), false);
  assert.equal(isTddExempt('wiring'), false);
});

test('case-insensitive / whitespace-tolerant', () => {
  assert.equal(isKnownTaskType('TDD-CODE'), true);
  assert.equal(isKnownTaskType('  docs  '), true);
  assert.equal(isTddExempt('Docs'), true);
});

test('gateContractFor returns per-Type contract shape', () => {
  const code = gateContractFor('tdd-code');
  assert.equal(code.kind, 'tdd-code');
  assert.equal(code.redRequiresTestFiles, true);
  assert.equal(code.rcdEmptyTrap, true);

  const docs = gateContractFor('docs');
  assert.equal(docs.kind, 'docs');
  assert.equal(docs.redRequiresTestFiles, false);
  assert.equal(docs.rcdEmptyTrap, false);

  const testsOnly = gateContractFor('tests-only');
  assert.equal(testsOnly.kind, 'tests-only');
  assert.equal(testsOnly.redRequiresTestFiles, false);
  assert.equal(testsOnly.rcdEmptyTrap, true);

  const ci = gateContractFor('ci');
  assert.equal(ci.rcdEmptyTrap, false);

  const cfg = gateContractFor('config');
  assert.equal(cfg.rcdEmptyTrap, false);
});

test('gateContractFor on unknown type defaults to tdd-code (strict)', () => {
  const unk = gateContractFor('wiring');
  assert.equal(unk.kind, 'tdd-code');
  assert.equal(unk.redRequiresTestFiles, true);
  assert.equal(unk.rcdEmptyTrap, true);
});

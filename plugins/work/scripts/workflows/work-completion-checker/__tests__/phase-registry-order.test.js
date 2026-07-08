'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMPLETION_PHASES,
  COMPLETION_PHASE_ORDER,
  COMPLETION_PHASE_TRANSITIONS,
} = require('../completion-phase-registry');

test('completion-phase-registry exports REUSE_AUDIT_ENFORCEMENT constant', () => {
  assert.equal(
    COMPLETION_PHASES.reuse_audit_enforcement,
    'reuse_audit_enforcement',
    'expected COMPLETION_PHASES.reuse_audit_enforcement to be defined',
  );
});

test('completion-phase-registry exports SUGGESTED_SCOPE_ENFORCEMENT constant', () => {
  assert.equal(
    COMPLETION_PHASES.suggested_scope_enforcement,
    'suggested_scope_enforcement',
    'expected COMPLETION_PHASES.suggested_scope_enforcement to be defined',
  );
});

test('completion-phase-registry exports TEST_PASS_CROSSREF constant', () => {
  assert.equal(
    COMPLETION_PHASES.test_pass_crossref,
    'test_pass_crossref',
    'expected COMPLETION_PHASES.test_pass_crossref to be defined',
  );
});

test('phase order places the three new phases between coverage_check and kind_checks', () => {
  const order = [...COMPLETION_PHASE_ORDER];
  const idxCoverage = order.indexOf('coverage_check');
  const idxReuse = order.indexOf('reuse_audit_enforcement');
  const idxSuggested = order.indexOf('suggested_scope_enforcement');
  const idxCrossref = order.indexOf('test_pass_crossref');
  const idxKind = order.indexOf('kind_checks');

  assert.ok(idxCoverage >= 0, 'coverage_check must be in order');
  assert.ok(idxReuse >= 0, 'reuse_audit_enforcement must be in order');
  assert.ok(idxSuggested >= 0, 'suggested_scope_enforcement must be in order');
  assert.ok(idxCrossref >= 0, 'test_pass_crossref must be in order');
  assert.ok(idxKind >= 0, 'kind_checks must be in order');

  assert.equal(idxReuse, idxCoverage + 1, 'reuse_audit_enforcement must immediately follow coverage_check');
  assert.equal(idxSuggested, idxReuse + 1, 'suggested_scope_enforcement must immediately follow reuse_audit_enforcement');
  assert.equal(idxCrossref, idxSuggested + 1, 'test_pass_crossref must immediately follow suggested_scope_enforcement');
  assert.equal(idxKind, idxCrossref + 1, 'kind_checks must immediately follow test_pass_crossref');
});

test('transitions form the chain coverage_check → reuse_audit_enforcement → suggested_scope_enforcement → test_pass_crossref → kind_checks', () => {
  assert.deepEqual(
    [...(COMPLETION_PHASE_TRANSITIONS.coverage_check || [])],
    ['reuse_audit_enforcement'],
    'coverage_check.next should be [reuse_audit_enforcement]',
  );
  assert.deepEqual(
    [...(COMPLETION_PHASE_TRANSITIONS.reuse_audit_enforcement || [])],
    ['suggested_scope_enforcement'],
    'reuse_audit_enforcement.next should be [suggested_scope_enforcement]',
  );
  assert.deepEqual(
    [...(COMPLETION_PHASE_TRANSITIONS.suggested_scope_enforcement || [])],
    ['test_pass_crossref'],
    'suggested_scope_enforcement.next should be [test_pass_crossref]',
  );
  assert.deepEqual(
    [...(COMPLETION_PHASE_TRANSITIONS.test_pass_crossref || [])],
    ['kind_checks'],
    'test_pass_crossref.next should be [kind_checks]',
  );
});

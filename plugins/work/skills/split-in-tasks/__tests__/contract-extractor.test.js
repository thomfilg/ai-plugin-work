'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', 'lib', 'contract-extractor.js');
const FIXTURE_DIRTY = path.resolve(__dirname, 'fixtures', 'echo-5362');
const FIXTURE_CLEAN = path.resolve(__dirname, 'fixtures', 'echo-5362-clean');

describe('contract-extractor — extractExports', () => {
  it('extracts the consumer signature from echo-5362 deleter-select-field.tsx and references data.map', () => {
    const { extractExports } = require(MODULE_PATH);
    const filePath = path.join(FIXTURE_DIRTY, 'deleter-select-field.tsx');
    const result = extractExports(filePath);
    assert.ok(Array.isArray(result), 'extractExports must return an array');
    assert.ok(result.length > 0, 'expected at least one export entry');
    const combined = result.map((e) => e.signature || '').join('\n');
    assert.match(combined, /data\.map/, 'expected an entry whose signature references data.map');
  });

  it('returns producer signature shape for echo-5362 router.ts referencing deleters', () => {
    const { extractExports } = require(MODULE_PATH);
    const filePath = path.join(FIXTURE_DIRTY, 'router.ts');
    const result = extractExports(filePath);
    assert.ok(Array.isArray(result) && result.length > 0, 'expected exports');
    const combined = result.map((e) => e.signature || '').join('\n');
    assert.match(combined, /deleters/, 'expected producer signature mentioning deleters');
  });
});

describe('contract-extractor — safeResolve / path traversal guard', () => {
  it('throws when filePath resolves outside the project root', () => {
    const { extractExports } = require(MODULE_PATH);
    assert.throws(
      () => extractExports('../../../../etc/passwd', { root: FIXTURE_DIRTY }),
      /escape|outside|traversal/i,
      'expected an error mentioning traversal/escape/outside root'
    );
  });

  it('safeResolve is exported and throws for escaping paths', () => {
    const { safeResolve } = require(MODULE_PATH);
    assert.equal(typeof safeResolve, 'function', 'safeResolve must be a function');
    assert.throws(
      () => safeResolve(FIXTURE_DIRTY, '../../../../etc/passwd'),
      /escape|outside|traversal/i
    );
  });
});

describe('contract-extractor — compareSignatures', () => {
  it('returns {equal:false, diff:...} when shapes differ', () => {
    const { compareSignatures } = require(MODULE_PATH);
    const consumer = { signature: 'data: Array<{ id: string; label: string }>' };
    const producer = { signature: '{ deleters: Deleter[] }' };
    const result = compareSignatures(consumer, producer);
    assert.equal(result.equal, false, 'expected equal:false on differing shapes');
    assert.ok(result.diff, 'expected diff payload');
  });

  it('returns {equal:true} when shapes match', () => {
    const { compareSignatures } = require(MODULE_PATH);
    const a = { signature: 'data: Array<{ id: string }>' };
    const b = { signature: 'data: Array<{ id: string }>' };
    const result = compareSignatures(a, b);
    assert.equal(result.equal, true);
  });
});

describe('contract-extractor — runPassB on echo-5362 fixture (dirty)', () => {
  it('emits exactly one warning citing the contract mismatch and at least one sibling ticket ID', () => {
    const { runPassB } = require(MODULE_PATH);
    const out = runPassB(FIXTURE_DIRTY);
    assert.ok(out, 'runPassB must return a result');
    assert.ok(Array.isArray(out.warnings), 'expected warnings array');
    assert.equal(out.warnings.length, 1, `expected exactly one warning, got ${out.warnings.length}`);
    const w = out.warnings[0];
    assert.equal(w.kind, 'B', 'expected Pass B warning');
    assert.match(
      `${w.message} ${w.hint || ''}`,
      /mismatch|diverge|contract|differ/i,
      'expected mismatch/divergence wording'
    );
    assert.match(
      `${w.message} ${w.hint || ''}`,
      /[A-Z]+-\d+/,
      'expected sibling ticket ID in message or hint'
    );
  });
});

describe('contract-extractor — runPassB on echo-5362-clean fixture', () => {
  it('emits zero warnings when no divergence exists', () => {
    const { runPassB } = require(MODULE_PATH);
    const out = runPassB(FIXTURE_CLEAN);
    assert.ok(out, 'runPassB must return a result');
    assert.ok(Array.isArray(out.warnings), 'expected warnings array');
    assert.equal(out.warnings.length, 0, `expected zero warnings, got ${out.warnings.length}`);
  });
});

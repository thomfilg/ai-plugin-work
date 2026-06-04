'use strict';

/**
 * Regression test for ECHO-4450: gitDiffFiles was double-prefixing the base
 * branch, producing `origin/origin/main...HEAD` which git rejects with
 * "ambiguous argument". Caused by `\`origin/${base}\`` when getBaseBranch()
 * already returned `origin/main`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBaseCandidates } = require('../check');

test('strips existing origin/ prefix to avoid double-prefix', () => {
  assert.deepEqual(buildBaseCandidates('origin/main'), ['origin/main', 'main']);
  assert.deepEqual(buildBaseCandidates('origin/dev'), ['origin/dev', 'dev']);
});

test('adds origin/ when input is a bare branch name', () => {
  assert.deepEqual(buildBaseCandidates('main'), ['origin/main', 'main']);
  assert.deepEqual(buildBaseCandidates('dev'), ['origin/dev', 'dev']);
});

test('handles empty/falsy input by defaulting to main', () => {
  assert.deepEqual(buildBaseCandidates(''), ['origin/main', 'main']);
  assert.deepEqual(buildBaseCandidates(undefined), ['origin/main', 'main']);
});

test('does not produce origin/origin/* in any output', () => {
  for (const input of ['origin/main', 'origin/dev', 'main', 'dev', '', undefined]) {
    const candidates = buildBaseCandidates(input);
    for (const c of candidates) {
      assert.ok(
        !c.startsWith('origin/origin/'),
        `Got double-prefixed candidate "${c}" for input "${input}"`
      );
    }
  }
});

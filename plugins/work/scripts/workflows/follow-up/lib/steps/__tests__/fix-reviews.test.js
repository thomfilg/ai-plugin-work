'use strict';

// fix-reviews.test.js — Task 7 (GH-537): assert delegate-block strings use
// the new --mark-locally-solved / --mark-locally-skipped flag names.
//
// Strategy: read fix-reviews.js as source text and assert the substrings
// appear (or are absent). This mirrors monitor.test.js's source-text style.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIX_REVIEWS_PATH = path.resolve(__dirname, '..', 'fix-reviews.js');
const SOURCE = fs.readFileSync(FIX_REVIEWS_PATH, 'utf8');

describe('fix-reviews delegate block (Task 7)', () => {
  it('Delegate-block text in fix-reviews.js uses the new flag names', () => {
    assert.ok(
      SOURCE.includes('--mark-locally-solved'),
      'expected delegate block to reference --mark-locally-solved'
    );
    assert.ok(
      SOURCE.includes('--mark-locally-skipped'),
      'expected delegate block to reference --mark-locally-skipped'
    );
    assert.ok(
      !SOURCE.includes('--solve-comment'),
      'expected NO remaining references to --solve-comment'
    );
    assert.ok(
      !SOURCE.includes('--skip-comment'),
      'expected NO remaining references to --skip-comment'
    );
  });

  it('uses --mark-locally-solved instead of --solve-comment', () => {
    assert.ok(
      SOURCE.includes('--mark-locally-solved'),
      'expected delegate block to reference --mark-locally-solved'
    );
    assert.ok(
      !SOURCE.includes('--solve-comment'),
      'expected NO remaining references to --solve-comment'
    );
  });

  it('uses --mark-locally-skipped instead of --skip-comment', () => {
    assert.ok(
      SOURCE.includes('--mark-locally-skipped'),
      'expected delegate block to reference --mark-locally-skipped'
    );
    assert.ok(
      !SOURCE.includes('--skip-comment'),
      'expected NO remaining references to --skip-comment'
    );
  });
});

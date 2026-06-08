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

  // GH-537 followup — the opt-in GitHub-resolve flag was withdrawn entirely
  // (the autonomous /work agent must never act on external state per
  // [[never-solve-bot-comments]] and [[never-comment-external-systems]]).
  // This regression guard prevents the concept from being re-advertised.
  it('does NOT advertise --also-resolve-on-github to agents', () => {
    assert.ok(
      !SOURCE.includes('--also-resolve-on-github'),
      'delegate block must not reintroduce the withdrawn opt-in GitHub-resolve flag'
    );
  });
});

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

describe('fix-reviews judgment step (Task 1, GH-352)', () => {
  // 1.1 — Verify-the-code judgment step before the fix-or-skip choice
  it('prompts the agent to judge the comment before acting (heading present)', () => {
    assert.ok(
      /Before you act/i.test(SOURCE),
      'expected a judgment heading like "Before you act" in the prompt'
    );
  });

  it('instructs the agent to read the referenced code at fileRef', () => {
    assert.ok(
      /read the (referenced )?code/i.test(SOURCE),
      'expected an instruction to read the referenced code'
    );
    assert.ok(SOURCE.includes('fileRef'), 'expected the judgment step to reference fileRef');
  });

  it("instructs the agent to verify the bot's claim against the current code", () => {
    assert.ok(/[Vv]erify.*claim/.test(SOURCE), "expected an instruction to verify the bot's claim");
    assert.ok(
      /current code/i.test(SOURCE),
      'expected the verification to be against the current code'
    );
  });

  it('places the judgment step before the Option A / Option B action block', () => {
    const judgmentIdx = SOURCE.search(/Before you act/i);
    const actionIdx = SOURCE.indexOf('## You MUST do exactly ONE of these:');
    assert.ok(judgmentIdx !== -1, 'expected a judgment heading');
    assert.ok(actionIdx !== -1, 'expected the existing action block');
    assert.ok(
      judgmentIdx < actionIdx,
      'expected the judgment step to appear before the action block'
    );
  });

  // 1.2 — Six-category classification taxonomy with prescribed actions
  it('lists all six classification categories', () => {
    assert.ok(/real bug/i.test(SOURCE), 'expected "real bug" category');
    assert.ok(/real improvement/i.test(SOURCE), 'expected "real improvement" category');
    assert.ok(/style\/naming/i.test(SOURCE), 'expected "style/naming preference" category');
    assert.ok(/false positive/i.test(SOURCE), 'expected "false positive" category');
    assert.ok(
      /conflicts with (the )?user intent/i.test(SOURCE),
      'expected "conflicts with user intent" category'
    );
    assert.ok(/ambiguous/i.test(SOURCE), 'expected "ambiguous" category');
  });

  it('states the prescribed action for false positive (skip with evidence)', () => {
    assert.ok(
      /false positive[\s\S]{0,80}skip[\s\S]{0,40}evidence/i.test(SOURCE),
      'expected "false positive" to prescribe skip with evidence'
    );
  });

  it('states the prescribed action for ambiguous (ask the user)', () => {
    assert.ok(
      /ambiguous[\s\S]{0,80}ask the user/i.test(SOURCE),
      'expected "ambiguous" to prescribe asking the user'
    );
  });

  // 1.3 — Record the classification inside the solve/skip reason
  it('requires the chosen category in the skip reason string', () => {
    assert.ok(
      /classification|category/i.test(SOURCE),
      'expected an instruction referencing the chosen classification/category'
    );
    assert.ok(
      /<reason>/.test(SOURCE),
      'expected the skip reason placeholder <reason> to be referenced'
    );
    assert.ok(/\[<category>\]/.test(SOURCE), 'expected a leading [<category>] token instruction');
  });

  it('requires the chosen category in the solve description string', () => {
    assert.ok(
      /<description>/.test(SOURCE),
      'expected the solve description placeholder <description> to be referenced'
    );
    assert.ok(
      /--mark-locally-solved/.test(SOURCE),
      'expected the solve command to remain referenced'
    );
  });
});

describe('fix-reviews preserved action contract (Task 1, GH-352)', () => {
  // 1.4 — Preserve the existing action contract
  it('still presents exactly one of Option A / Option B', () => {
    assert.ok(SOURCE.includes('Option A'), 'expected Option A to remain');
    assert.ok(SOURCE.includes('Option B'), 'expected Option B to remain');
  });

  it('still references both --mark-locally-* flags', () => {
    assert.ok(SOURCE.includes('--mark-locally-solved'));
    assert.ok(SOURCE.includes('--mark-locally-skipped'));
  });

  it('still contains the Do NOT pipe the output guidance', () => {
    assert.ok(SOURCE.includes('Do NOT pipe the output'), 'expected the no-pipe guidance to remain');
  });

  it('does not reintroduce the legacy flag names', () => {
    assert.ok(!SOURCE.includes('--solve-comment'));
    assert.ok(!SOURCE.includes('--skip-comment'));
  });
});

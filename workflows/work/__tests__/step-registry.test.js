/**
 * Tests for workflows/work/step-registry.js
 *
 * GH-215: Verifies that the `brief_gate` step constant is declared and
 * inserted into ALL_STEPS immediately between `brief` and `spec`. The gate
 * step must sit between brief and spec so the orchestrator can evaluate
 * unresolved cross-ticket / architectural questions before spec planning.
 *
 * Run: node --test workflows/work/__tests__/step-registry.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { STEPS, ALL_STEPS, STEP_ORDER, STEP_TRANSITIONS } = require(path.join(__dirname, '..', 'step-registry'));

describe('step-registry', () => {
  describe('STEPS constant map', () => {
    it('declares brief_gate identifier', () => {
      assert.equal(STEPS.brief_gate, 'brief_gate');
    });

    it('still declares the surrounding brief and spec identifiers', () => {
      assert.equal(STEPS.brief, 'brief');
      assert.equal(STEPS.spec, 'spec');
    });
  });

  describe('ALL_STEPS ordering', () => {
    it('includes brief_gate', () => {
      assert.ok(ALL_STEPS.includes('brief_gate'), 'ALL_STEPS should contain brief_gate');
    });

    it('inserts brief_gate immediately after brief', () => {
      const briefIdx = ALL_STEPS.indexOf('brief');
      const gateIdx = ALL_STEPS.indexOf('brief_gate');
      assert.ok(briefIdx >= 0, 'brief must exist in ALL_STEPS');
      assert.equal(gateIdx, briefIdx + 1);
    });

    it('inserts brief_gate immediately before spec', () => {
      const specIdx = ALL_STEPS.indexOf('spec');
      const gateIdx = ALL_STEPS.indexOf('brief_gate');
      assert.ok(specIdx >= 0, 'spec must exist in ALL_STEPS');
      assert.equal(gateIdx, specIdx - 1);
    });

    it('STEP_ORDER reflects the same brief -> brief_gate -> spec sequence', () => {
      const briefIdx = STEP_ORDER.indexOf('brief');
      const gateIdx = STEP_ORDER.indexOf('brief_gate');
      const specIdx = STEP_ORDER.indexOf('spec');
      assert.equal(gateIdx, briefIdx + 1);
      assert.equal(specIdx, gateIdx + 1);
    });
  });

  // GH-211: task_review step — per-task review gate between commit and check
  describe('task_review step (GH-211)', () => {
    it('declares task_review identifier in STEPS', () => {
      assert.equal(STEPS.task_review, 'task_review');
    });

    it('includes task_review in ALL_STEPS', () => {
      assert.ok(ALL_STEPS.includes('task_review'), 'ALL_STEPS should contain task_review');
    });

    it('inserts task_review immediately after commit in STEP_ORDER', () => {
      const commitIdx = STEP_ORDER.indexOf('commit');
      const reviewIdx = STEP_ORDER.indexOf('task_review');
      assert.ok(commitIdx >= 0, 'commit must exist in STEP_ORDER');
      assert.ok(reviewIdx >= 0, 'task_review must exist in STEP_ORDER');
      assert.equal(reviewIdx, commitIdx + 1);
    });

    it('inserts task_review immediately before check in STEP_ORDER', () => {
      const checkIdx = STEP_ORDER.indexOf('check');
      const reviewIdx = STEP_ORDER.indexOf('task_review');
      assert.ok(checkIdx >= 0, 'check must exist in STEP_ORDER');
      assert.equal(reviewIdx, checkIdx - 1);
    });

    it('STEP_ORDER reflects commit -> task_review -> check sequence', () => {
      const commitIdx = STEP_ORDER.indexOf('commit');
      const reviewIdx = STEP_ORDER.indexOf('task_review');
      const checkIdx = STEP_ORDER.indexOf('check');
      assert.equal(reviewIdx, commitIdx + 1);
      assert.equal(checkIdx, reviewIdx + 1);
    });

    it('RETRY_EDGES maps task_review to implement', () => {
      // task_review can transition back to implement (retry on review failure)
      assert.ok(
        STEP_TRANSITIONS['task_review'].includes('implement'),
        'task_review should have a retry edge to implement'
      );
    });

    it('task_review can transition forward to check', () => {
      assert.ok(
        STEP_TRANSITIONS['task_review'].includes('check'),
        'task_review should transition forward to check'
      );
    });
  });
});

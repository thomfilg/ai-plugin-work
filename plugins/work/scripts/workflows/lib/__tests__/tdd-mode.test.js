'use strict';

/**
 * lib/tdd-mode.js — WORK_TDD_MODE resolution.
 *
 * The contract that matters: an UNSET variable resolves to `outcome`. The
 * legacy `process` choreography and `shadow` observation are explicit
 * opt-ins, so a regression that reinstates the old default (a bare
 * `process.env.WORK_TDD_MODE === 'outcome'` comparison) fails here.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  MODES,
  KNOWN_MODES,
  DEFAULT_TDD_MODE,
  normalizeTddMode,
  resolveTddMode,
  resolveConfiguredTddMode,
  isOutcomeMode,
  isShadowMode,
  isProcessMode,
} = require(path.join(__dirname, '..', 'tdd-mode'));

const ORIGINAL = process.env.WORK_TDD_MODE;

function setEnvMode(value) {
  if (value === undefined) delete process.env.WORK_TDD_MODE;
  else process.env.WORK_TDD_MODE = value;
}

afterEach(() => setEnvMode(ORIGINAL));

describe('lib/tdd-mode.js', () => {
  describe('the default', () => {
    it('resolves an unset WORK_TDD_MODE to outcome', () => {
      assert.equal(DEFAULT_TDD_MODE, MODES.outcome);
      assert.equal(resolveTddMode({}), MODES.outcome);
      assert.equal(isOutcomeMode({}), true);
      assert.equal(isProcessMode({}), false);
      assert.equal(isShadowMode({}), false);
    });

    it('resolves an empty / whitespace value to outcome', () => {
      assert.equal(resolveTddMode({ WORK_TDD_MODE: '' }), MODES.outcome);
      assert.equal(resolveTddMode({ WORK_TDD_MODE: '   ' }), MODES.outcome);
    });

    it('resolves an unrecognized value to outcome rather than throwing', () => {
      // config-validate.js is what warns about a malformed value; resolution
      // is total.
      assert.equal(resolveTddMode({ WORK_TDD_MODE: 'proces' }), MODES.outcome);
      assert.equal(normalizeTddMode(null), MODES.outcome);
      assert.equal(normalizeTddMode(undefined), MODES.outcome);
      assert.equal(normalizeTddMode(7), MODES.outcome);
    });

    it('reads process.env when no env object is passed', () => {
      setEnvMode(undefined);
      assert.equal(resolveTddMode(), MODES.outcome);
      setEnvMode('process');
      assert.equal(resolveTddMode(), MODES.process);
    });
  });

  describe('explicit opt-ins', () => {
    it('honours process and shadow', () => {
      assert.equal(resolveTddMode({ WORK_TDD_MODE: 'process' }), MODES.process);
      assert.equal(isProcessMode({ WORK_TDD_MODE: 'process' }), true);
      assert.equal(isOutcomeMode({ WORK_TDD_MODE: 'process' }), false);

      assert.equal(resolveTddMode({ WORK_TDD_MODE: 'shadow' }), MODES.shadow);
      assert.equal(isShadowMode({ WORK_TDD_MODE: 'shadow' }), true);
      assert.equal(isOutcomeMode({ WORK_TDD_MODE: 'shadow' }), false);
    });

    it('is case- and whitespace-insensitive', () => {
      assert.equal(resolveTddMode({ WORK_TDD_MODE: ' PROCESS ' }), MODES.process);
      assert.equal(resolveTddMode({ WORK_TDD_MODE: 'Shadow' }), MODES.shadow);
    });

    it('exposes exactly the three known modes', () => {
      assert.deepEqual([...KNOWN_MODES].sort(), ['outcome', 'process', 'shadow']);
    });
  });

  describe('resolveConfiguredTddMode()', () => {
    it('prefers an explicit process.env value', () => {
      setEnvMode('process');
      assert.equal(resolveConfiguredTddMode(), MODES.process);
    });

    it('defaults to outcome when nothing configures the mode', () => {
      setEnvMode(undefined);
      assert.equal(resolveConfiguredTddMode(), MODES.outcome);
    });
  });
});

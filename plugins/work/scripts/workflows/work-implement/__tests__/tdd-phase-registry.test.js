/**
 * Tests for tdd-phase-registry.js
 *
 * Run with: node --test workflows/work-implement/__tests__/tdd-phase-registry.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  TDD_PHASES,
  TDD_PHASE_ORDER,
  tddCanTransition,
  isTestFile,
  isTestHelper,
  PHASE_HOOKS,
  PHASE_EVIDENCE,
} = require('../tdd-phase-registry');

describe('tdd-phase-registry', () => {
  describe('TDD_PHASES', () => {
    it('has red, green, refactor', () => {
      assert.strictEqual(TDD_PHASES.red, 'red');
      assert.strictEqual(TDD_PHASES.green, 'green');
      assert.strictEqual(TDD_PHASES.refactor, 'refactor');
    });
  });

  describe('TDD_PHASE_ORDER', () => {
    it('is [red, green, refactor]', () => {
      assert.deepStrictEqual(TDD_PHASE_ORDER, ['red', 'green', 'refactor']);
    });
  });

  describe('tddCanTransition', () => {
    it('red -> green is valid', () => {
      assert.strictEqual(tddCanTransition('red', 'green'), true);
    });

    it('green -> refactor is valid', () => {
      assert.strictEqual(tddCanTransition('green', 'refactor'), true);
    });

    it('refactor -> red is valid', () => {
      assert.strictEqual(tddCanTransition('refactor', 'red'), true);
    });

    it('red -> refactor is invalid', () => {
      assert.strictEqual(tddCanTransition('red', 'refactor'), false);
    });

    // RC-A defense: GREEN→RED is the legitimate path for test-correction.
    // Agents who discover their test assertions don't match shipped reality
    // (e.g., ECHO-4457: spec asserted testids missing from shipped sibling
    // components) need a way back to RED without orchestrator rewind.
    it('green -> red is valid (test-correction back-edge)', () => {
      assert.strictEqual(tddCanTransition('green', 'red'), true);
    });

    it('red -> red is invalid (no self-loop)', () => {
      assert.strictEqual(tddCanTransition('red', 'red'), false);
    });

    it('refactor -> green is invalid', () => {
      assert.strictEqual(tddCanTransition('refactor', 'green'), false);
    });
  });

  describe('isTestFile', () => {
    it('foo.test.ts -> true', () => {
      assert.strictEqual(isTestFile('foo.test.ts'), true);
    });

    it('foo.spec.js -> true', () => {
      assert.strictEqual(isTestFile('foo.spec.js'), true);
    });

    it('src/components/Button.test.tsx -> true', () => {
      assert.strictEqual(isTestFile('src/components/Button.test.tsx'), true);
    });

    it('foo.ts -> false', () => {
      assert.strictEqual(isTestFile('foo.ts'), false);
    });

    it('foo.testing.ts -> false', () => {
      assert.strictEqual(isTestFile('foo.testing.ts'), false);
    });
  });

  describe('isTestHelper', () => {
    it('__mocks__/foo.js -> true', () => {
      assert.strictEqual(isTestHelper('__mocks__/foo.js'), true);
    });

    it('__fixtures__/data.json -> true', () => {
      assert.strictEqual(isTestHelper('__fixtures__/data.json'), true);
    });

    it('test-utils.ts -> true', () => {
      assert.strictEqual(isTestHelper('test-utils.ts'), true);
    });

    it('test-utils/render.tsx -> true', () => {
      assert.strictEqual(isTestHelper('test-utils/render.tsx'), true);
    });

    it('foo.mock.ts -> true', () => {
      assert.strictEqual(isTestHelper('foo.mock.ts'), true);
    });

    it('data.fixture.js -> true', () => {
      assert.strictEqual(isTestHelper('data.fixture.js'), true);
    });

    it('test-helper.ts -> true', () => {
      assert.strictEqual(isTestHelper('test-helper.ts'), true);
    });

    it('src/app.ts -> false', () => {
      assert.strictEqual(isTestHelper('src/app.ts'), false);
    });

    it('foo.test.ts -> false (test files are not helpers)', () => {
      assert.strictEqual(isTestHelper('foo.test.ts'), false);
    });
  });

  describe('PHASE_HOOKS', () => {
    describe('RED phase', () => {
      it('shouldBlock production file -> true', () => {
        assert.strictEqual(PHASE_HOOKS.red.shouldBlock('src/app.ts'), true);
      });

      it('shouldBlock test file -> false', () => {
        assert.strictEqual(PHASE_HOOKS.red.shouldBlock('src/app.test.ts'), false);
      });
    });

    describe('GREEN phase', () => {
      it('shouldBlock test file -> true', () => {
        assert.strictEqual(PHASE_HOOKS.green.shouldBlock('src/app.test.ts'), true);
      });

      it('shouldBlock production file -> false', () => {
        assert.strictEqual(PHASE_HOOKS.green.shouldBlock('src/app.ts'), false);
      });

      it('shouldBlock __mocks__ helper -> false', () => {
        assert.strictEqual(PHASE_HOOKS.green.shouldBlock('__mocks__/api.js'), false);
      });

      it('shouldBlock __fixtures__ helper -> false', () => {
        assert.strictEqual(PHASE_HOOKS.green.shouldBlock('__fixtures__/data.json'), false);
      });

      it('shouldBlock test-utils -> false', () => {
        assert.strictEqual(PHASE_HOOKS.green.shouldBlock('test-utils.ts'), false);
      });

      it('shouldBlock .mock file -> false', () => {
        assert.strictEqual(PHASE_HOOKS.green.shouldBlock('foo.mock.ts'), false);
      });
    });

    describe('REFACTOR phase', () => {
      it('shouldBlock anything.ts -> false', () => {
        assert.strictEqual(PHASE_HOOKS.refactor.shouldBlock('anything.ts'), false);
      });

      it('shouldBlock anything.test.ts -> false', () => {
        assert.strictEqual(PHASE_HOOKS.refactor.shouldBlock('anything.test.ts'), false);
      });
    });
  });

  describe('PHASE_EVIDENCE', () => {
    it('RED requires changed test files and test failure', () => {
      assert.deepStrictEqual(PHASE_EVIDENCE.red, {
        requiresChangedTestFiles: true,
        requiresTestFailure: true,
      });
    });

    it('GREEN requires test success', () => {
      assert.deepStrictEqual(PHASE_EVIDENCE.green, {
        requiresTestSuccess: true,
      });
    });

    it('REFACTOR requires test success', () => {
      assert.deepStrictEqual(PHASE_EVIDENCE.refactor, {
        requiresTestSuccess: true,
      });
    });
  });
});

'use strict';

/**
 * GH-570 — `red-mode:` validation in validateStrategyShape.
 *
 * The optional `red-mode: ablation` key marks a regression-coverage task
 * (tests pinning already-working behavior — no natural failing RED). The
 * draft gate must accept it on runnable kinds, reject unknown values, and
 * reject it on citation kinds (which run no command of their own).
 *
 * Run: node --test scripts/workflows/lib/__tests__/test-strategy-red-mode.test.js
 *
 * (Separate file from test-strategy.test.js to respect the 400-line
 * max-lines quality budget — that suite is at 399 lines.)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { validateStrategyShape, RED_MODES } = require(path.join(__dirname, '..', 'test-strategy'));

const TASK = { heading: 'Task 3 — Pin /s flag behavior' };

describe('validateStrategyShape — red-mode (GH-570)', () => {
  it('exports RED_MODES with ablation as the only mode', () => {
    assert.deepEqual(Object.values(RED_MODES), ['ablation']);
  });

  it('accepts red-mode: ablation on kind=unit', () => {
    const errors = validateStrategyShape(
      { kind: 'unit', entry: 'lib/__tests__/x.test.js', redMode: 'ablation' },
      TASK
    );
    assert.deepEqual(errors, []);
  });

  it('accepts red-mode: ablation on kind=integration, e2e, and custom', () => {
    for (const strategy of [
      { kind: 'integration', entry: 'lib/__tests__/x.integration.test.js', redMode: 'ablation' },
      { kind: 'e2e', entry: 'tests/e2e/x.spec.ts', redMode: 'ablation' },
      { kind: 'custom', command: 'node lib/verify.js', redMode: 'ablation' },
    ]) {
      const errors = validateStrategyShape(strategy, TASK);
      assert.deepEqual(errors, [], `kind=${strategy.kind} should accept ablation`);
    }
  });

  it('accepts a strategy with no redMode field (back-compat)', () => {
    const errors = validateStrategyShape({ kind: 'unit', entry: 'lib/__tests__/x.test.js' }, TASK);
    assert.deepEqual(errors, []);
  });

  it('rejects an unknown red-mode value, naming the value and the allowed set', () => {
    const errors = validateStrategyShape(
      { kind: 'unit', entry: 'lib/__tests__/x.test.js', redMode: 'mutation-party' },
      TASK
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /unknown red-mode 'mutation-party'/);
    assert.match(errors[0], /ablation/);
    assert.match(errors[0], /^Task 3/);
  });

  it('rejects red-mode: ablation on citation kinds (verified-by / wiring-citation)', () => {
    for (const kind of ['verified-by', 'wiring-citation']) {
      const errors = validateStrategyShape({ kind, peer: 'Task 1', redMode: 'ablation' }, TASK);
      assert.equal(errors.length, 1, `kind=${kind} must reject ablation`);
      assert.match(
        errors[0],
        /only legal for kind=unit, kind=integration, kind=e2e, or kind=custom/
      );
      assert.match(errors[0], new RegExp(`kind=${kind}`));
    }
  });

  it('reports the kind error first when both kind and red-mode are invalid', () => {
    const errors = validateStrategyShape({ kind: 'bogus', redMode: 'weird' }, TASK);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /unknown kind 'bogus'/);
  });
});

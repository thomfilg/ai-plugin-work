'use strict';

/**
 * Unit tests for lib/test-strategy.js — RED phase for GH-590 task6.
 *
 * Covers AC1 (KINDS enum), AC2 (synthesizeCommand), AC11 (validatePeerCitation).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const MODULE_PATH = path.join(__dirname, '..', 'test-strategy.js');

function loadModule() {
  if (!fs.existsSync(MODULE_PATH)) {
    // RED: probe behaviorally — return missing-shape exports so test bodies
    // run their assertions and fail with meaningful messages rather than
    // crashing the file at require().
    return {
      __missing: true,
      KINDS: {},
      synthesizeCommand: () => 'UNIMPLEMENTED',
      validatePeerCitation: () => ['UNIMPLEMENTED'],
    };
  }
  return require(MODULE_PATH);
}

describe('lib/test-strategy.js', () => {
  describe('AC1 — KINDS enum', () => {
    it('exports KINDS with UNIT, INTEGRATION, VERIFIED_BY, WIRING_CITATION, CUSTOM', () => {
      const { KINDS } = loadModule();
      assert.equal(KINDS.UNIT, 'unit');
      assert.equal(KINDS.INTEGRATION, 'integration');
      assert.equal(KINDS.VERIFIED_BY, 'verified-by');
      assert.equal(KINDS.WIRING_CITATION, 'wiring-citation');
      assert.equal(KINDS.CUSTOM, 'custom');
    });
  });

  describe('AC2 — synthesizeCommand', () => {
    it('returns envelope with CHANGED_FILES=entry when $TEST_UNIT_COMMAND is set (kind=unit)', () => {
      const { synthesizeCommand } = loadModule();
      const envrc = {
        vars: {
          TEST_UNIT_COMMAND: 'pnpm test:unit -- $CHANGED_FILES',
        },
      };
      const strategy = { kind: 'unit', entry: 'src/foo.test.js' };
      const out = synthesizeCommand(strategy, envrc);
      assert.match(out, /CHANGED_FILES=("|')src\/foo\.test\.js("|')/);
      assert.match(out, /\$TEST_UNIT_COMMAND/);
    });

    it('returns envelope with CHANGED_FILES=entry when $TEST_INTEGRATION_COMMAND is set (kind=integration)', () => {
      const { synthesizeCommand } = loadModule();
      const envrc = {
        vars: {
          TEST_INTEGRATION_COMMAND: 'pnpm test:integration -- $CHANGED_FILES',
        },
      };
      const strategy = { kind: 'integration', entry: 'src/bar.integration.test.js' };
      const out = synthesizeCommand(strategy, envrc);
      assert.match(out, /CHANGED_FILES=("|')src\/bar\.integration\.test\.js("|')/);
      assert.match(out, /\$TEST_INTEGRATION_COMMAND/);
    });

    it('falls back to `pnpm test <entry>` when no envelope var is set (kind=unit)', () => {
      const { synthesizeCommand } = loadModule();
      const envrc = { vars: {} };
      const strategy = { kind: 'unit', entry: 'src/baz.test.js' };
      const out = synthesizeCommand(strategy, envrc);
      assert.equal(out, 'pnpm test src/baz.test.js');
    });

    it('returns null for kind=verified-by (no command to synthesize)', () => {
      const { synthesizeCommand } = loadModule();
      const envrc = { vars: { TEST_UNIT_COMMAND: 'whatever' } };
      const strategy = { kind: 'verified-by', peer: 'Task 7' };
      assert.equal(synthesizeCommand(strategy, envrc), null);
    });

    it('returns null for kind=wiring-citation', () => {
      const { synthesizeCommand } = loadModule();
      const strategy = { kind: 'wiring-citation', peer: 'Task 9' };
      assert.equal(synthesizeCommand(strategy, { vars: {} }), null);
    });

    it('returns customBody verbatim for kind=custom', () => {
      const { synthesizeCommand } = loadModule();
      const strategy = {
        kind: 'custom',
        customBody: 'pnpm dev:typecheck && grep -q foo bar.ts',
      };
      assert.equal(
        synthesizeCommand(strategy, { vars: {} }),
        'pnpm dev:typecheck && grep -q foo bar.ts'
      );
    });

    it('prefers strategy.command (canonical) over strategy.customBody (legacy) for kind=custom', () => {
      const { synthesizeCommand } = loadModule();
      const strategy = {
        kind: 'custom',
        command: 'pnpm dev:check',
        customBody: 'stale legacy body',
      };
      assert.equal(synthesizeCommand(strategy, { vars: {} }), 'pnpm dev:check');
    });

    it('returns envelope with CHANGED_FILES=entry when $TEST_E2E_COMMAND is set (kind=e2e)', () => {
      const { synthesizeCommand } = loadModule();
      const envrc = {
        vars: {
          TEST_E2E_COMMAND: 'pnpm test:e2e -- $CHANGED_FILES',
        },
      };
      const strategy = { kind: 'e2e', entry: 'tests/e2e/foo.spec.ts' };
      const out = synthesizeCommand(strategy, envrc);
      assert.match(out, /CHANGED_FILES=("|')tests\/e2e\/foo\.spec\.ts("|')/);
      assert.match(out, /\$TEST_E2E_COMMAND/);
    });
  });

  describe('AC1 — KINDS.E2E', () => {
    it('exports KINDS.E2E === "e2e"', () => {
      const { KINDS } = loadModule();
      assert.equal(KINDS.E2E, 'e2e');
    });
  });

  describe('validateStrategyShape — enum + required-key gate', () => {
    const citingTask = { heading: 'Task 4' };

    it('returns error naming the bad kind and listing allowed values', () => {
      const { validateStrategyShape } = loadModule();
      const errs = validateStrategyShape({ kind: 'foobar' }, citingTask);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /Task 4/);
      assert.match(errs[0], /foobar/);
      for (const k of ['unit', 'integration', 'e2e', 'custom', 'verified-by', 'wiring-citation']) {
        assert.match(errs[0], new RegExp(k));
      }
    });

    it('returns error when kind=unit has no entry', () => {
      const { validateStrategyShape } = loadModule();
      const errs = validateStrategyShape({ kind: 'unit' }, citingTask);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /kind=unit/);
      assert.match(errs[0], /entry/);
    });

    it('returns error when kind=integration has no entry', () => {
      const { validateStrategyShape } = loadModule();
      const errs = validateStrategyShape({ kind: 'integration' }, citingTask);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /kind=integration/);
      assert.match(errs[0], /entry/);
    });

    it('returns error when kind=e2e has no entry', () => {
      const { validateStrategyShape } = loadModule();
      const errs = validateStrategyShape({ kind: 'e2e' }, citingTask);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /kind=e2e/);
      assert.match(errs[0], /entry/);
    });

    it('returns error when kind=custom has no command and no customBody', () => {
      const { validateStrategyShape } = loadModule();
      const errs = validateStrategyShape({ kind: 'custom' }, citingTask);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /kind=custom/);
      assert.match(errs[0], /command/);
    });

    it('returns error when kind is missing', () => {
      const { validateStrategyShape } = loadModule();
      const errs = validateStrategyShape({ entry: 'foo.test.js' }, citingTask);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /kind/);
    });

    it('returns [] for a valid kind=unit strategy', () => {
      const { validateStrategyShape } = loadModule();
      assert.deepEqual(
        validateStrategyShape({ kind: 'unit', entry: 'src/foo.test.js' }, citingTask),
        []
      );
    });

    it('returns [] for a valid kind=custom strategy with command', () => {
      const { validateStrategyShape } = loadModule();
      assert.deepEqual(
        validateStrategyShape({ kind: 'custom', command: 'pnpm dev:check' }, citingTask),
        []
      );
    });

    it('returns [] for a valid kind=custom strategy with customBody only', () => {
      const { validateStrategyShape } = loadModule();
      assert.deepEqual(
        validateStrategyShape({ kind: 'custom', customBody: 'pnpm dev:check' }, citingTask),
        []
      );
    });

    it("returns [] for kind=verified-by (peer-field is validatePeerCitation's job)", () => {
      const { validateStrategyShape } = loadModule();
      assert.deepEqual(
        validateStrategyShape({ kind: 'verified-by', peer: 'Task 7' }, citingTask),
        []
      );
    });

    it('returns [] for null/undefined strategy (nothing to validate)', () => {
      const { validateStrategyShape } = loadModule();
      assert.deepEqual(validateStrategyShape(null, citingTask), []);
      assert.deepEqual(validateStrategyShape(undefined, citingTask), []);
    });
  });

  describe('AC11 — validatePeerCitation', () => {
    const citingTask = {
      heading: 'Task 10',
      filesInScope: ['src/feature/handler.js'],
      strategy: { kind: 'verified-by', peer: 'Task 7' },
    };

    it('returns [] (no errors) when peer exists, peer kind is unit, and entry references citing scope', () => {
      const { validatePeerCitation } = loadModule();
      const allTasks = [
        citingTask,
        {
          heading: 'Task 7',
          strategy: { kind: 'unit', entry: 'src/feature/handler.test.js' },
        },
      ];
      const errs = validatePeerCitation(citingTask.strategy, allTasks, citingTask);
      assert.deepEqual(errs, []);
    });

    it('returns error when cited peer does not exist', () => {
      const { validatePeerCitation } = loadModule();
      const allTasks = [citingTask];
      const errs = validatePeerCitation(citingTask.strategy, allTasks, citingTask);
      assert.ok(errs.length >= 1, 'expected at least one error');
      assert.ok(
        errs.some((e) => /Task 7/.test(e) && /not found|does not exist|missing/i.test(e)),
        `expected missing-peer error, got: ${JSON.stringify(errs)}`
      );
    });

    it('returns error when peer kind is not unit|integration (e.g. peer is also verified-by)', () => {
      const { validatePeerCitation } = loadModule();
      const allTasks = [
        citingTask,
        {
          heading: 'Task 7',
          strategy: { kind: 'verified-by', peer: 'Task 99' },
        },
      ];
      const errs = validatePeerCitation(citingTask.strategy, allTasks, citingTask);
      assert.ok(errs.length >= 1);
      assert.ok(
        errs.some((e) => /kind/i.test(e) && /unit|integration/i.test(e)),
        `expected wrong-kind-peer error, got: ${JSON.stringify(errs)}`
      );
    });

    it('returns error when peer entry does not transitively reference any citing-scope path', () => {
      const { validatePeerCitation } = loadModule();
      const allTasks = [
        citingTask,
        {
          heading: 'Task 7',
          strategy: { kind: 'unit', entry: 'src/other/unrelated.test.js' },
        },
      ];
      const errs = validatePeerCitation(citingTask.strategy, allTasks, citingTask);
      assert.ok(errs.length >= 1);
      assert.ok(
        errs.some((e) => /scope|reference|overlap/i.test(e)),
        `expected non-overlapping-entry error, got: ${JSON.stringify(errs)}`
      );
    });
  });
});

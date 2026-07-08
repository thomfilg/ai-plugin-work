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
const { spawnSync } = require('node:child_process');

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

    it('returns customBody with a strict-mode prefix for chained kind=custom bodies (W9)', () => {
      // Chained bodies get `set -e; set -o pipefail; ` prepended so a failing
      // middle segment can no longer be masked by a passing final one.
      const { synthesizeCommand } = loadModule();
      const strategy = {
        kind: 'custom',
        customBody: 'pnpm dev:typecheck && grep -q foo bar.ts',
      };
      assert.equal(
        synthesizeCommand(strategy, { vars: {} }),
        'set -e; set -o pipefail; pnpm dev:typecheck && grep -q foo bar.ts'
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

    it('returns single unchained kind=custom commands verbatim (no strict prefix)', () => {
      // An unchained command's exit code cannot be masked; leaving it verbatim
      // also preserves the recorder's anchored fake-command detection.
      const { synthesizeCommand } = loadModule();
      const strategy = { kind: 'custom', command: 'pnpm dev:check' };
      assert.equal(synthesizeCommand(strategy, { vars: {} }), 'pnpm dev:check');
    });

    it('prefixes multi-line kind=custom bodies with strict mode (W9)', () => {
      const { synthesizeCommand } = loadModule();
      const strategy = {
        kind: 'custom',
        customBody: 'node scripts/check-a.js\nnode scripts/check-b.js',
      };
      assert.equal(
        synthesizeCommand(strategy, { vars: {} }),
        'set -e; set -o pipefail; node scripts/check-a.js\nnode scripts/check-b.js'
      );
    });

    it('does not double-prefix a body that already begins with set -', () => {
      const { synthesizeCommand } = loadModule();
      const strategy = {
        kind: 'custom',
        command: 'set -euo pipefail; pnpm lint && pnpm test',
      };
      assert.equal(
        synthesizeCommand(strategy, { vars: {} }),
        'set -euo pipefail; pnpm lint && pnpm test'
      );
    });

    it('multi-line custom body where line 1 fails exits non-zero when run (W9 regression)', () => {
      // echo-4449/5152: under `bash -lc`, a multi-line body's exit code is the
      // LAST line's — `false` on line 1 was masked by `true` on line 2. The
      // synthesized command must fail.
      const { synthesizeCommand } = loadModule();
      const cmd = synthesizeCommand({ kind: 'custom', customBody: 'false\ntrue' }, { vars: {} });
      const run = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' });
      assert.notEqual(run.status, 0, `expected non-zero exit for: ${cmd}`);
    });

    it('multi-line custom body where every line passes still exits 0 when run', () => {
      const { synthesizeCommand } = loadModule();
      const cmd = synthesizeCommand({ kind: 'custom', customBody: 'true\ntrue' }, { vars: {} });
      const run = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' });
      assert.equal(run.status, 0, `expected exit 0 for: ${cmd}, stderr: ${run.stderr}`);
    });

    it('pipeline failure in a chained body is not masked (pipefail active)', () => {
      const { synthesizeCommand } = loadModule();
      const cmd = synthesizeCommand(
        { kind: 'custom', customBody: 'false | cat; true' },
        { vars: {} }
      );
      const run = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' });
      assert.notEqual(run.status, 0, `expected non-zero exit for: ${cmd}`);
    });

    // Bypass review (W9 follow-up): a SINGLE pipe is chaining too — without
    // the prefix, `pytest | tee out.log` exits with tee's 0 and the exact
    // echo-4449/5152 masking survives via `|`.
    it('prefixes single-pipe custom commands with strict mode (W9 follow-up)', () => {
      const { synthesizeCommand } = loadModule();
      const strategy = { kind: 'custom', command: 'pnpm test | tee out.log' };
      assert.equal(
        synthesizeCommand(strategy, { vars: {} }),
        'set -e; set -o pipefail; pnpm test | tee out.log'
      );
    });

    it('single-pipe failure is not masked by the pipe tail when run', () => {
      const { synthesizeCommand } = loadModule();
      const cmd = synthesizeCommand({ kind: 'custom', customBody: 'false | cat' }, { vars: {} });
      const run = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' });
      assert.notEqual(run.status, 0, `expected non-zero exit for: ${cmd}`);
    });

    // Bypass review (W9 follow-up): only an errexit prefix counts as already
    // strict. `set -x`/`set -f` bodies previously matched `/^\s*set\s+-/` and
    // silently skipped the strict prefix — failure masking returned.
    it('a body starting with non-strict set -x still gets the strict prefix', () => {
      const { synthesizeCommand } = loadModule();
      const strategy = { kind: 'custom', customBody: 'set -x; false; true' };
      assert.equal(
        synthesizeCommand(strategy, { vars: {} }),
        'set -e; set -o pipefail; set -x; false; true'
      );
      const run = spawnSync('bash', ['-lc', 'set -e; set -o pipefail; set -x; false; true'], {
        encoding: 'utf8',
      });
      assert.notEqual(run.status, 0, 'the failing middle segment must fail the command');
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

const { describe: dAc12, it: iAc12 } = require('node:test');
const assertAc12 = require('node:assert/strict');
const stratAc12 = require('../test-strategy');

dAc12('AC12: cross-task-test relaxation — entry may reference peer-owned paths', () => {
  iAc12(
    'verified-by accepts when peer entry strip-matches citing scope (peer reads citing-owned path)',
    () => {
      // Citing task owns src/feature.ts only (no test of its own). The peer
      // task's entry src/feature.test.ts strip-matches src/feature.ts — i.e.
      // the peer test reads the citing task's owned production file. AC12
      // says: that's legitimate; the implement-step scope hook still blocks
      // edits outside scope. Validator accepts.
      const peer = {
        num: 1,
        filesInScope: ['src/feature.test.ts'],
        testStrategy: { kind: 'unit', entry: 'src/feature.test.ts' },
      };
      const citing = {
        num: 2,
        filesInScope: ['src/feature.ts'],
        testStrategy: { kind: 'verified-by', peer: 'Task 1' },
      };
      const errs = stratAc12.validatePeerCitation(citing.testStrategy, [peer, citing], citing);
      assertAc12.equal(errs.length, 0, JSON.stringify(errs));
    }
  );
  iAc12(
    'wiring-citation accepts when peer scope is a superset (peer tests already exercise barrel)',
    () => {
      const peer = {
        num: 1,
        filesInScope: ['src/new-mod.ts', 'src/new-mod.test.ts', 'src/barrel.ts'],
        testStrategy: { kind: 'integration', entry: 'src/new-mod.test.ts' },
      };
      const citing = {
        num: 2,
        filesInScope: ['src/barrel.ts'],
        testStrategy: { kind: 'wiring-citation', peer: 'Task 1' },
      };
      const errs = stratAc12.validatePeerCitation(citing.testStrategy, [peer, citing], citing);
      assertAc12.equal(errs.length, 0, JSON.stringify(errs));
    }
  );
});

'use strict';

/**
 * W12 — unit tests for the generation-time strategy satisfiability validator
 * (lib/test-strategy.js validateStrategySatisfiability) and for the W12
 * unification move of detectMalformedTestCommand into the shared lib
 * (implement-gate/test-command.js must re-export the SAME function).
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateStrategySatisfiability, detectMalformedTestCommand } = require('../test-strategy');

function task(overrides = {}) {
  return { num: 3, filesInScope: [], ...overrides };
}

describe('detectMalformedTestCommand (shared lib home)', () => {
  it('is the SAME function the implement gate exports (one implementation, both phases)', () => {
    const gate = require(
      path.join(
        __dirname,
        '..',
        '..',
        'work',
        'lib',
        'step-enrichments',
        'implement-gate',
        'test-command.js'
      )
    );
    assert.equal(gate.detectMalformedTestCommand, detectMalformedTestCommand);
  });

  const cases = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['bash', 'bare-interpreter'],
    ['node  ', 'bare-interpreter'],
    ['```', 'backticks-only'],
    ['```bash\npnpm test', 'fence-opener'],
    ['`pnpm test', 'stray-backtick'],
    ['pnpm test`', 'stray-backtick'],
  ];
  for (const [cmd, reason] of cases) {
    it(`flags ${JSON.stringify(cmd)} as ${reason}`, () => {
      assert.equal(detectMalformedTestCommand(cmd), reason);
    });
  }

  it('accepts a normal runnable command', () => {
    assert.equal(detectMalformedTestCommand('node --test lib/__tests__/foo.test.js'), null);
  });
});

describe('validateStrategySatisfiability — envelope kinds', () => {
  const tmpDirs = [];
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function mkWorkDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w12-satisfiability-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('rejects an entry that is not a test file', () => {
    const errors = validateStrategySatisfiability({ kind: 'unit', entry: 'src/foo.js' }, task(), {
      workDir: mkWorkDir(),
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not a test file/);
    assert.match(errors[0], /src\/foo\.js/);
  });

  it('rejects a literal test entry that neither exists nor is covered by the task scope', () => {
    const errors = validateStrategySatisfiability(
      { kind: 'integration', entry: 'src/missing.test.js' },
      task({ filesInScope: ['docs/**'] }),
      { workDir: mkWorkDir() }
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /does not exist/);
    assert.match(errors[0], /Files in scope/);
  });

  it('accepts a literal test entry that exists on disk', () => {
    const workDir = mkWorkDir();
    fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'src', 'foo.test.js'), '// t\n');
    const errors = validateStrategySatisfiability(
      { kind: 'unit', entry: 'src/foo.test.js' },
      task(),
      { workDir }
    );
    assert.deepEqual(errors, []);
  });

  it('accepts a missing test entry that the task itself will create (entry in scope)', () => {
    const errors = validateStrategySatisfiability(
      { kind: 'unit', entry: 'src/new-thing.test.js' },
      task({ filesInScope: ['src/new-thing.js', 'src/new-thing.test.js'] }),
      { workDir: mkWorkDir() }
    );
    assert.deepEqual(errors, []);
  });

  it('accepts a missing test entry covered by a scope glob', () => {
    const errors = validateStrategySatisfiability(
      { kind: 'e2e', entry: 'e2e/checkout.spec.ts' },
      task({ filesInScope: ['e2e/**'] }),
      { workDir: mkWorkDir() }
    );
    assert.deepEqual(errors, []);
  });

  it('skips the existence probe for glob entries (pattern check still applies)', () => {
    const ok = validateStrategySatisfiability({ kind: 'unit', entry: 'src/**/*.test.js' }, task(), {
      workDir: mkWorkDir(),
    });
    assert.deepEqual(ok, []);
    const bad = validateStrategySatisfiability({ kind: 'unit', entry: 'src/**' }, task(), {
      workDir: mkWorkDir(),
    });
    assert.equal(bad.length, 1);
    assert.match(bad[0], /not a test file/);
  });

  it('fails open on existence without a workDir, but still enforces the test-file pattern', () => {
    assert.deepEqual(
      validateStrategySatisfiability({ kind: 'unit', entry: 'never/created.test.js' }, task(), {}),
      []
    );
    const errors = validateStrategySatisfiability(
      { kind: 'unit', entry: 'src/foo.js' },
      task(),
      undefined
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not a test file/);
  });

  it('leaves the missing-entry error to the shape gate (empty entry → no errors here)', () => {
    assert.deepEqual(validateStrategySatisfiability({ kind: 'unit' }, task(), {}), []);
  });

  // Bugs review (W12 follow-up) — kind=e2e must accept the entry shapes the
  // plugin's own docs teach (skills/split-in-tasks/docs/test-strategy.md:
  // "`*.e2e.test.*` or `tests/e2e/**`"), because the implement gate executes
  // e2e via the TEST_E2E_COMMAND envelope / `pnpm test <entry>` fallback,
  // which run directory globs and `.e2e.` specs fine.
  describe('kind=e2e entry shapes (doc-legal forms are satisfiable)', () => {
    it('accepts the documented directory glob tests/e2e/**', () => {
      assert.deepEqual(
        validateStrategySatisfiability({ kind: 'e2e', entry: 'tests/e2e/**' }, task(), {
          workDir: mkWorkDir(),
        }),
        []
      );
    });

    it('accepts a Playwright-style .e2e. spec without a .test./.spec. infix', () => {
      const workDir = mkWorkDir();
      fs.mkdirSync(path.join(workDir, 'tests', 'e2e'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'tests', 'e2e', 'checkout.e2e.ts'), '// t\n');
      assert.deepEqual(
        validateStrategySatisfiability(
          { kind: 'e2e', entry: 'tests/e2e/checkout.e2e.ts' },
          task(),
          { workDir }
        ),
        []
      );
    });

    it('still applies the existence/scope probe to literal e2e entries', () => {
      const errors = validateStrategySatisfiability(
        { kind: 'e2e', entry: 'tests/e2e/missing.e2e.ts' },
        task({ filesInScope: ['docs/**'] }),
        { workDir: mkWorkDir() }
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0], /does not exist/);
    });

    it('rejects an e2e entry that is neither test-shaped nor e2e-shaped', () => {
      const errors = validateStrategySatisfiability({ kind: 'e2e', entry: 'src/**' }, task(), {
        workDir: mkWorkDir(),
      });
      assert.equal(errors.length, 1);
      assert.match(errors[0], /not a test file/);
      assert.match(errors[0], /tests\/e2e\/\*\*/, 'error names the accepted e2e shapes');
    });

    it('keeps unit/integration strict: an e2e-dir entry is NOT valid for kind=unit', () => {
      const errors = validateStrategySatisfiability(
        { kind: 'unit', entry: 'tests/e2e/**' },
        task(),
        { workDir: mkWorkDir() }
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0], /not a test file/);
    });
  });
});

describe('validateStrategySatisfiability — custom + citation kinds', () => {
  it('rejects a malformed custom command with the shared trap reason', () => {
    const errors = validateStrategySatisfiability(
      { kind: 'custom', command: '```bash\npnpm test' },
      task(),
      {}
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /malformed \(fence-opener\)/);
  });

  it('rejects a malformed custom fenced body (bare interpreter)', () => {
    const errors = validateStrategySatisfiability(
      { kind: 'custom', customBody: 'bash' },
      task(),
      {}
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /bare-interpreter/);
  });

  it('accepts a runnable custom command', () => {
    assert.deepEqual(
      validateStrategySatisfiability(
        { kind: 'custom', command: 'node --test lib/__tests__/x.test.js' },
        task(),
        {}
      ),
      []
    );
  });

  it('leaves the missing-command error to the shape gate', () => {
    assert.deepEqual(validateStrategySatisfiability({ kind: 'custom' }, task(), {}), []);
  });

  it('returns no errors for citation kinds (validatePeerCitation owns them)', () => {
    for (const kind of ['verified-by', 'wiring-citation']) {
      assert.deepEqual(validateStrategySatisfiability({ kind, peer: 'Task 1' }, task(), {}), []);
    }
  });

  it('returns no errors for null/non-object strategies', () => {
    assert.deepEqual(validateStrategySatisfiability(null, task(), {}), []);
    assert.deepEqual(validateStrategySatisfiability('unit', task(), {}), []);
  });
});

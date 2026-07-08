'use strict';

/**
 * Tests for safeSubprocess — spawnSync/execFileSync wrappers with a
 * non-optional timeout policy.
 *
 * Run: node --test factories/safeSubprocess/__tests__/safeSubprocess.test.js
 *
 * Hermetic and cross-platform: every fixture invokes Node itself (via
 * process.execPath) with inline scripts instead of POSIX utilities, which
 * are not available on Windows.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { safeSpawnSync, safeExecFileSync } = require('../safeSubprocess');

const nodePath = process.execPath;

const isTypeError = (re) => (err) => err instanceof TypeError && re.test(err.message);

// ─── safeSpawnSync — raw result passthrough ─────────────────────────────────

describe('safeSpawnSync — raw result passthrough', () => {
  it('returns the raw spawnSync result object (status + stdout)', () => {
    const r = safeSpawnSync(nodePath, ['-e', 'console.log("hello")'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(typeof r.stdout, 'string');
    assert.equal(r.stdout.trim(), 'hello');
    assert.equal(typeof r.pid, 'number');
  });

  it('supports the status===0 && stdout.trim() ? trimmed : null caller predicate', () => {
    // A migrating call site keeps its exact success predicate over the raw
    // result — the wrapper must not bake in trimming or fallback semantics.
    const ok = safeSpawnSync(nodePath, ['-e', 'console.log("  /some/toplevel  ")'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const okValue = ok.status === 0 && ok.stdout.trim() ? ok.stdout.trim() : null;
    assert.equal(okValue, '/some/toplevel');

    const bad = safeSpawnSync(nodePath, ['-e', 'process.exit(3)'], { encoding: 'utf8' });
    const badValue = bad.status === 0 && bad.stdout.trim() ? bad.stdout.trim() : null;
    assert.equal(badValue, null);
    assert.equal(bad.status, 3);
  });

  it('does not throw on nonzero exit — failure stays in the result', () => {
    const r = safeSpawnSync(nodePath, ['-e', 'process.exit(1)'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
  });

  it('does not throw when the binary is missing — error stays in the result', () => {
    const r = safeSpawnSync('__nonexistent_command_abc123__', []);
    assert.ok(r.error instanceof Error);
  });
});

// ─── Timeout policy ─────────────────────────────────────────────────────────

describe('safeSpawnSync — timeout policy', () => {
  it('kills a slow process when an explicit timeout elapses', () => {
    const r = safeSpawnSync(nodePath, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeout: 500,
      encoding: 'utf8',
    });
    assert.ok(r.error || r.signal, 'expected timeout to populate error/signal');
    assert.notEqual(r.status, 0);
  });

  it('applies the default timeout: fast commands succeed with no timeout passed', () => {
    const r = safeSpawnSync(nodePath, ['-e', 'console.log("fast")'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'fast');
  });

  it('throws TypeError for timeout: 0 — disabled timeouts are refused', () => {
    assert.throws(
      () => safeSpawnSync(nodePath, ['-e', ''], { timeout: 0 }),
      isTypeError(/timeout/)
    );
  });

  it('throws TypeError for every non-positive/non-integer/non-number timeout', () => {
    // 15.5 and 5e-324 are positive and finite but not integers — Node's own
    // validateTimeout would reject them later with a RangeError; the factory
    // must catch them up front with its own TypeError instead.
    const bads = [
      null,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '5000',
      '15000',
      false,
      15.5,
      5e-324,
    ];
    for (const bad of bads) {
      assert.throws(
        () => safeSpawnSync(nodePath, ['-e', ''], { timeout: bad }),
        isTypeError(/timeout/),
        `expected timeout=${String(bad)} to throw`
      );
    }
  });

  it('safeExecFileSync enforces the same timeout policy', () => {
    assert.throws(
      () => safeExecFileSync(nodePath, ['-e', ''], { timeout: 0 }),
      isTypeError(/timeout/)
    );
  });
});

// ─── noTimeout justification ────────────────────────────────────────────────

describe('safeSubprocess — noTimeout justification', () => {
  it('runs without a deadline when a justification is supplied', () => {
    const r = safeSpawnSync(nodePath, ['-e', 'console.log("no-deadline")'], {
      encoding: 'utf8',
      noTimeout: 'fixture self-terminates immediately',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'no-deadline');
  });

  it('omits timeout from the final opts — a deadline that would fire is not applied', () => {
    // Without noTimeout, timeout: 50 would kill this 300ms fixture. It
    // surviving proves the timeout key was stripped, not merely enlarged.
    const r = safeSpawnSync(nodePath, ['-e', 'setTimeout(() => console.log("survived"), 300)'], {
      encoding: 'utf8',
      timeout: 50,
      noTimeout: 'proves the deadline is removed; fixture exits after 300ms',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'survived');
  });

  it('throws TypeError for an empty justification', () => {
    assert.throws(
      () => safeSpawnSync(nodePath, ['-e', ''], { noTimeout: '' }),
      isTypeError(/noTimeout/)
    );
  });

  it('throws TypeError for whitespace-only or non-string justifications', () => {
    for (const bad of ['   ', true, 42, {}]) {
      assert.throws(
        () => safeSpawnSync(nodePath, ['-e', ''], { noTimeout: bad }),
        isTypeError(/noTimeout/),
        `expected noTimeout=${String(bad)} to throw`
      );
    }
  });
});

// ─── Input validation ───────────────────────────────────────────────────────

describe('safeSubprocess — input validation', () => {
  const both = [safeSpawnSync, safeExecFileSync];

  it('throws TypeError when command is not a non-empty string', () => {
    for (const fn of both) {
      for (const bad of [null, undefined, '', 42]) {
        assert.throws(() => fn(bad), isTypeError(/non-empty string/));
      }
    }
  });

  it('throws TypeError when args is not an array of strings', () => {
    for (const fn of both) {
      for (const bad of ['not-array', [123], { 0: 'foo' }]) {
        assert.throws(() => fn('cmd', bad), isTypeError(/array of strings/));
      }
    }
  });

  it('throws TypeError when opts is not an object', () => {
    assert.throws(() => safeSpawnSync(nodePath, [], null), isTypeError(/opts/));
    assert.throws(() => safeSpawnSync(nodePath, [], []), isTypeError(/opts/));
  });
});

// ─── Shell stripping ────────────────────────────────────────────────────────

describe('safeSubprocess — shell stripping', () => {
  it('safeSpawnSync ignores shell: true — metacharacters stay literal', () => {
    const r = safeSpawnSync(
      nodePath,
      ['-e', 'process.stdout.write(process.argv[1])', '--', 'a && b; echo injected'],
      { encoding: 'utf8', shell: true }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'a && b; echo injected');
  });

  it('safeExecFileSync ignores shell: true — substitution syntax stays literal', () => {
    const out = safeExecFileSync(
      nodePath,
      ['-e', 'process.stdout.write(process.argv[1])', '--', '$(whoami) `id`'],
      { encoding: 'utf8', shell: true }
    );
    assert.equal(out, '$(whoami) `id`');
  });
});

// ─── safeExecFileSync — native semantics ────────────────────────────────────

describe('safeExecFileSync — native semantics', () => {
  it('returns stdout on success', () => {
    const out = safeExecFileSync(nodePath, ['-e', 'process.stdout.write("exec-ok")'], {
      encoding: 'utf8',
    });
    assert.equal(out, 'exec-ok');
  });

  it('throws on nonzero exit with the status attached', () => {
    assert.throws(
      () => safeExecFileSync(nodePath, ['-e', 'process.exit(2)'], { encoding: 'utf8' }),
      (err) => err.status === 2
    );
  });

  it('throws when an explicit timeout elapses', () => {
    assert.throws(
      () =>
        safeExecFileSync(nodePath, ['-e', 'setTimeout(() => {}, 60000)'], {
          timeout: 500,
          encoding: 'utf8',
        }),
      (err) => err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT'
    );
  });
});

// ─── Options passthrough ────────────────────────────────────────────────────

describe('safeSubprocess — options passthrough', () => {
  it('honors cwd', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-subprocess-'));
    try {
      const r = safeSpawnSync(nodePath, ['-e', 'process.stdout.write(process.cwd())'], {
        cwd: tmpDir,
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
      // tmpdir can be a symlink on some platforms; realpath both sides.
      assert.equal(fs.realpathSync(r.stdout), fs.realpathSync(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('honors input', () => {
    const out = safeExecFileSync(nodePath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'piped-input',
      encoding: 'utf8',
    });
    assert.equal(out, 'piped-input');
  });

  it('honors env', () => {
    const r = safeSpawnSync(
      nodePath,
      ['-e', 'process.stdout.write(process.env.SAFE_SUBPROCESS_TEST || "")'],
      { encoding: 'utf8', env: { ...process.env, SAFE_SUBPROCESS_TEST: 'env-ok' } }
    );
    assert.equal(r.stdout, 'env-ok');
  });

  it('honors stdio (stderr ignored still yields stdout)', () => {
    const r = safeSpawnSync(nodePath, ['-e', 'console.log("ok"); console.error("noise")'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'ok');
    assert.equal(r.stderr, null);
  });
});

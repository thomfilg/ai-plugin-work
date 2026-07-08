const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MODULE_PATH = path.join(__dirname, '..', 'gh-exec.js');

let tmpDir;
let originalPath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-exec-'));
  originalPath = process.env.PATH;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

/**
 * Write a fake `gh` script into a fresh dir, prepend to PATH, and return the
 * dir so the test can clean up. Repeated invocations of `gh` log args to a
 * file so tests can assert on how `gh` was called.
 *
 * The shell script dispatches on its first arg:
 *   gh <real-args>   -> primary call (json or arbitrary)
 *   gh auth status   -> diagnostic subprocess
 *
 * Behavior is parameterized via env vars in the fake `gh`:
 *   FAKE_GH_MAIN_STDOUT, FAKE_GH_MAIN_STDERR, FAKE_GH_MAIN_EXIT
 *   FAKE_GH_AUTH_STDOUT, FAKE_GH_AUTH_STDERR, FAKE_GH_AUTH_EXIT
 *   FAKE_GH_CALL_LOG (path)
 */
function installFakeGh() {
  const shimDir = fs.mkdtempSync(path.join(tmpDir, 'shim-'));
  const ghPath = path.join(shimDir, 'gh');
  const callLog = path.join(shimDir, 'calls.log');
  const script = `#!/bin/sh
echo "$@" >> "$FAKE_GH_CALL_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$FAKE_GH_AUTH_STDOUT" ]; then printf '%s' "$FAKE_GH_AUTH_STDOUT"; fi
  if [ -n "$FAKE_GH_AUTH_STDERR" ]; then printf '%s' "$FAKE_GH_AUTH_STDERR" 1>&2; fi
  exit \${FAKE_GH_AUTH_EXIT:-0}
fi
if [ -n "$FAKE_GH_MAIN_STDOUT" ]; then printf '%s' "$FAKE_GH_MAIN_STDOUT"; fi
if [ -n "$FAKE_GH_MAIN_STDERR" ]; then printf '%s' "$FAKE_GH_MAIN_STDERR" 1>&2; fi
exit \${FAKE_GH_MAIN_EXIT:-0}
`;
  fs.writeFileSync(ghPath, script, { mode: 0o755 });
  process.env.PATH = `${shimDir}:${originalPath}`;
  process.env.FAKE_GH_CALL_LOG = callLog;
  return { shimDir, callLog };
}

function setFakeGhEnv({
  mainStdout = '',
  mainStderr = '',
  mainExit = 0,
  authStdout = '',
  authStderr = '',
  authExit = 0,
} = {}) {
  process.env.FAKE_GH_MAIN_STDOUT = mainStdout;
  process.env.FAKE_GH_MAIN_STDERR = mainStderr;
  process.env.FAKE_GH_MAIN_EXIT = String(mainExit);
  process.env.FAKE_GH_AUTH_STDOUT = authStdout;
  process.env.FAKE_GH_AUTH_STDERR = authStderr;
  process.env.FAKE_GH_AUTH_EXIT = String(authExit);
}

function clearFakeGhEnv() {
  for (const k of [
    'FAKE_GH_MAIN_STDOUT',
    'FAKE_GH_MAIN_STDERR',
    'FAKE_GH_MAIN_EXIT',
    'FAKE_GH_AUTH_STDOUT',
    'FAKE_GH_AUTH_STDERR',
    'FAKE_GH_AUTH_EXIT',
    'GH_EXEC_NO_DIAG',
  ]) {
    delete process.env[k];
  }
}

function freshRequire() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

function readCalls(callLog) {
  if (!fs.existsSync(callLog)) return [];
  return fs
    .readFileSync(callLog, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Run `fn` with the token/config env vars set to `vars` (any key not listed is
 * deleted), restoring the real values afterward. Lets the precedence tests
 * drive `buildChildEnv()` deterministically without leaking into sibling tests.
 */
function withTokenEnv(vars, fn) {
  const keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR'];
  const saved = {};
  for (const k of keys) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const AUTH_STATUS_OUTPUT_TWO_ACCOUNTS = [
  'github.com',
  '  ✓ Logged in to github.com account thomfilg (keyring)',
  '  - Active account: true',
  '  - Git operations protocol: ssh',
  '  ✓ Logged in to github.com account otherbot (keyring)',
  '  - Active account: false',
  '',
].join('\n');

describe('gh-exec.js — buildChildEnv token precedence', () => {
  it('(a) honors a GH_TOKEN-only env (GITHUB_TOKEN absent)', () => {
    withTokenEnv({ GH_TOKEN: 'tok-a' }, () => {
      const { buildChildEnv } = freshRequire();
      const env = buildChildEnv();
      assert.equal(env.GH_TOKEN, 'tok-a');
      assert.equal('GITHUB_TOKEN' in env, false);
    });
  });

  it('(b) honors a GITHUB_TOKEN-only env', () => {
    withTokenEnv({ GITHUB_TOKEN: 'tok-b' }, () => {
      const { buildChildEnv } = freshRequire();
      const env = buildChildEnv();
      assert.equal(env.GITHUB_TOKEN, 'tok-b');
      assert.equal('GH_TOKEN' in env, false);
    });
  });

  it('(c) GH_TOKEN wins when both are set', () => {
    withTokenEnv({ GH_TOKEN: 'tok-a', GITHUB_TOKEN: 'tok-b' }, () => {
      const { buildChildEnv } = freshRequire();
      const env = buildChildEnv();
      assert.equal(env.GH_TOKEN, 'tok-a');
      assert.equal('GITHUB_TOKEN' in env, false);
    });
  });

  it('(d) deletes both when neither is set (keyring fallback)', () => {
    withTokenEnv({}, () => {
      const { buildChildEnv } = freshRequire();
      const env = buildChildEnv();
      assert.equal('GH_TOKEN' in env, false);
      assert.equal('GITHUB_TOKEN' in env, false);
    });
  });

  it('(e) treats an empty-string GH_TOKEN as absent', () => {
    withTokenEnv({ GH_TOKEN: '' }, () => {
      const { buildChildEnv } = freshRequire();
      const env = buildChildEnv();
      assert.equal('GH_TOKEN' in env, false);
      assert.equal('GITHUB_TOKEN' in env, false);
    });
  });

  it('(g) treats empty GH_TOKEN as absent and honors GITHUB_TOKEN', () => {
    withTokenEnv({ GH_TOKEN: '', GITHUB_TOKEN: 'tok-b' }, () => {
      const { buildChildEnv } = freshRequire();
      const env = buildChildEnv();
      assert.equal(env.GITHUB_TOKEN, 'tok-b');
      assert.equal('GH_TOKEN' in env, false);
    });
  });

  it('(f) passes GH_CONFIG_DIR through unchanged', () => {
    withTokenEnv({ GH_CONFIG_DIR: '/iso/path' }, () => {
      const { buildChildEnv } = freshRequire();
      const env = buildChildEnv();
      assert.equal(env.GH_CONFIG_DIR, '/iso/path');
    });
  });

  it('returns a fresh object (no mutation of process.env)', () => {
    withTokenEnv({ GH_TOKEN: 'tok-a' }, () => {
      const { buildChildEnv } = freshRequire();
      const env = buildChildEnv();
      assert.notEqual(env, process.env);
      assert.equal(process.env.GH_TOKEN, 'tok-a');
    });
  });
});

describe('gh-exec.js — auth diagnostic', () => {
  describe('clean success path', () => {
    it('clean success path returns parsed JSON without diagnostic', () => {
      const { callLog } = installFakeGh();
      setFakeGhEnv({ mainStdout: '{"login":"thomfilg"}', mainExit: 0 });
      try {
        const { ghExec } = freshRequire();
        const result = ghExec(['api', 'user']);
        assert.deepEqual(result, { login: 'thomfilg' });
        const calls = readCalls(callLog);
        assert.equal(calls.length, 1);
        assert.equal(calls[0], 'api user');
        assert.equal(
          calls.some((c) => c.startsWith('auth status')),
          false,
          'gh auth status MUST NOT be spawned on the happy path'
        );
      } finally {
        clearFakeGhEnv();
      }
    });
  });

  describe('non-auth error', () => {
    it('non-auth error rethrows without diagnostic', () => {
      const { callLog } = installFakeGh();
      setFakeGhEnv({
        mainStderr: 'fatal: something unrelated blew up',
        mainExit: 1,
      });
      try {
        const { ghExec } = freshRequire();
        assert.throws(
          () => ghExec(['api', 'repos/foo/bar']),
          (err) => {
            assert.match(err.message, /gh command failed/);
            assert.match(err.message, /something unrelated blew up/);
            assert.doesNotMatch(err.message, /Likely auth issue/);
            return true;
          }
        );
        const calls = readCalls(callLog);
        assert.equal(
          calls.some((c) => c.startsWith('auth status')),
          false,
          'gh auth status MUST NOT be spawned for non-auth errors'
        );
      } finally {
        clearFakeGhEnv();
      }
    });
  });

  describe('auth-shaped error', () => {
    it('auth-shaped error appends diagnostic with active account', () => {
      const { callLog } = installFakeGh();
      setFakeGhEnv({
        mainStderr:
          "GraphQL: Could not resolve to a Repository with the name 'foo/bar' (repository)",
        mainExit: 1,
        authStdout: AUTH_STATUS_OUTPUT_TWO_ACCOUNTS,
        authExit: 0,
      });
      try {
        const { ghExec } = freshRequire();
        assert.throws(
          () => ghExec(['api', 'repos/foo/bar']),
          (err) => {
            assert.match(err.message, /gh command failed/);
            assert.match(err.message, /Could not resolve to a Repository/);
            assert.match(err.message, /Likely auth issue/);
            assert.match(err.message, /Active gh account:\s*thomfilg/);
            assert.match(err.message, /gh auth switch --user otherbot/);
            assert.match(err.message, /GH_TOKEN/);
            assert.doesNotMatch(err.message, /unset (your )?(GH_TOKEN|GITHUB_TOKEN)/i);
            return true;
          }
        );
        const calls = readCalls(callLog);
        assert.equal(
          calls.some((c) => c.startsWith('auth status')),
          true,
          'gh auth status MUST be spawned to build diagnostic'
        );
      } finally {
        clearFakeGhEnv();
      }
    });

    it('reconciled advice honors GH_TOKEN and never tells users to unset it', () => {
      installFakeGh();
      setFakeGhEnv({
        mainStderr:
          "GraphQL: Could not resolve to a Repository with the name 'foo/bar' (repository)",
        mainExit: 1,
        authStdout: AUTH_STATUS_OUTPUT_TWO_ACCOUNTS,
        authExit: 0,
      });
      try {
        const { ghExec } = freshRequire();
        assert.throws(
          () => ghExec(['api', 'repos/foo/bar']),
          (err) => {
            assert.match(err.message, /Likely auth issue/);
            assert.match(err.message, /GH_TOKEN/);
            assert.match(err.message, /now honored/i);
            assert.doesNotMatch(err.message, /unset (your )?(GH_TOKEN|GITHUB_TOKEN)/i);
            return true;
          }
        );
      } finally {
        clearFakeGhEnv();
      }
    });

    it('matches HTTP 401 / 403 / 404 / Resource not accessible / requires authentication', () => {
      const stderrs = [
        'HTTP 401: unauthorized',
        'HTTP 403: forbidden',
        'HTTP 404: not found',
        'Resource not accessible by integration',
        'gh: this command requires authentication',
      ];
      for (const stderrMsg of stderrs) {
        installFakeGh();
        setFakeGhEnv({
          mainStderr: stderrMsg,
          mainExit: 1,
          authStdout: AUTH_STATUS_OUTPUT_TWO_ACCOUNTS,
          authExit: 0,
        });
        try {
          const { ghExec } = freshRequire();
          assert.throws(
            () => ghExec(['api', 'repos/foo/bar']),
            (err) => {
              assert.match(
                err.message,
                /Likely auth issue/,
                `expected auth diagnostic for stderr "${stderrMsg}"`
              );
              return true;
            }
          );
        } finally {
          clearFakeGhEnv();
        }
      }
    });
  });

  describe('gh auth status itself fails', () => {
    it('gh auth status itself fails → fallback hint', () => {
      installFakeGh();
      setFakeGhEnv({
        mainStderr: 'HTTP 404: Could not resolve to a Repository',
        mainExit: 1,
        authStderr: 'gh auth status: not logged in to any host',
        authExit: 1,
      });
      try {
        const { ghExec } = freshRequire();
        assert.throws(
          () => ghExec(['api', 'repos/foo/bar']),
          (err) => {
            assert.match(err.message, /gh command failed/);
            assert.match(err.message, /Likely auth issue/);
            assert.match(err.message, /Run `gh auth status` to inspect active account/);
            assert.doesNotMatch(err.message, /Active gh account:/);
            return true;
          }
        );
      } finally {
        clearFakeGhEnv();
      }
    });
  });

  describe('GH_EXEC_NO_DIAG=1 opt-out', () => {
    it('GH_EXEC_NO_DIAG=1 opts out of the diagnostic', () => {
      const { callLog } = installFakeGh();
      setFakeGhEnv({
        mainStderr:
          "GraphQL: Could not resolve to a Repository with the name 'foo/bar' (repository)",
        mainExit: 1,
        authStdout: AUTH_STATUS_OUTPUT_TWO_ACCOUNTS,
        authExit: 0,
      });
      process.env.GH_EXEC_NO_DIAG = '1';
      try {
        const { ghExec } = freshRequire();
        assert.throws(
          () => ghExec(['api', 'repos/foo/bar']),
          (err) => {
            assert.match(err.message, /gh command failed/);
            assert.match(err.message, /Could not resolve to a Repository/);
            assert.doesNotMatch(err.message, /Likely auth issue/);
            assert.doesNotMatch(err.message, /Active gh account:/);
            return true;
          }
        );
        const calls = readCalls(callLog);
        assert.equal(
          calls.some((c) => c.startsWith('auth status')),
          false,
          'GH_EXEC_NO_DIAG=1 MUST suppress gh auth status spawn'
        );
      } finally {
        clearFakeGhEnv();
      }
    });
  });
});

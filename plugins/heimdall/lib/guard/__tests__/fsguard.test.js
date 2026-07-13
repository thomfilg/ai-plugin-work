// Unit tests for the runtime-shim wiring (GH-657).
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/guard/__tests__/fsguard.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { shimPath, runsExternalScript, buildShimRewrite, allowedAbsPaths } = require(
  path.resolve(__dirname, '..', 'fsguard')
);

describe('runsExternalScript', () => {
  it('detects interpreter + script file', () => {
    assert.ok(runsExternalScript('node /tmp/x.js'));
    assert.ok(runsExternalScript('python3 scripts/deploy.py --flag'));
    assert.ok(runsExternalScript('bash ./run.sh'));
  });
  it('is false for inline / no-file invocations', () => {
    assert.ok(!runsExternalScript('node --version'));
    assert.ok(!runsExternalScript('node -e "console.log(1)"'));
    assert.ok(!runsExternalScript('ls -la'));
  });
});

describe('shimPath kill-switch', () => {
  it('returns null when HEIMDALL_DISABLE_SHIM is set', () => {
    process.env.HEIMDALL_DISABLE_SHIM = '1';
    try {
      assert.equal(shimPath(), null);
    } finally {
      delete process.env.HEIMDALL_DISABLE_SHIM;
    }
  });
});

describe('buildShimRewrite', () => {
  const entries = [
    { dir: '/repo/.claude', isFile: false, allowedPaths: ['plans', 'projects'] },
    { dir: '/repo/.github', isFile: false, allowedPaths: null },
  ];

  it('prepends LD_PRELOAD + HEIMDALL_PROTECTED, preserving an existing preload', () => {
    const out = buildShimRewrite('node build.js', entries, '/x/heimdall-fsguard.so');
    assert.match(
      out,
      /export LD_PRELOAD='\/x\/heimdall-fsguard\.so'\$\{LD_PRELOAD:\+:\$LD_PRELOAD\};/
    );
    assert.match(out, /export HEIMDALL_PROTECTED='\/repo\/\.claude:\/repo\/\.github';/);
    assert.ok(out.endsWith('node build.js'));
  });

  it('emits allowed subdirs as absolute paths', () => {
    const out = buildShimRewrite('node build.js', entries, '/x/so');
    assert.match(
      out,
      /export HEIMDALL_ALLOWED='\/repo\/\.claude\/plans:\/repo\/\.claude\/projects';/
    );
  });

  it('allowedAbsPaths joins entry.dir with each allowed subdir', () => {
    assert.deepEqual(allowedAbsPaths(entries), ['/repo/.claude/plans', '/repo/.claude/projects']);
  });
});

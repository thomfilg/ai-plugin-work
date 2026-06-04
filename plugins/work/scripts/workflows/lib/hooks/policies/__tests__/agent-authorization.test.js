/**
 * Tests for policies/agent-authorization.js
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/agent-authorization.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  isTrustedScriptPath,
  expandPluginRoot,
  extractSubCommand,
  isSafeSubCommand,
  isExemptScriptInvocation,
} = require('../agent-authorization');

describe('agent-authorization: isTrustedScriptPath', () => {
  const trustedDirs = [path.resolve(__dirname, '..', '..', '..')]; // workflows/lib

  it('returns false for nonexistent path', () => {
    assert.equal(isTrustedScriptPath('/nonexistent/script.js', trustedDirs), false);
  });

  it('returns true when script resolves under a trusted dir', () => {
    // The agent-authorization module itself lives under workflows/lib/hooks/policies
    const realFile = path.resolve(__dirname, '..', 'agent-authorization.js');
    assert.equal(isTrustedScriptPath(realFile, trustedDirs), true);
  });

  it('returns false when script is outside trusted dirs', () => {
    const tmpFile = path.join(os.tmpdir(), `aa-untrusted-${process.pid}.js`);
    fs.writeFileSync(tmpFile, '// hi\n');
    try {
      assert.equal(isTrustedScriptPath(tmpFile, trustedDirs), false);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe('agent-authorization: expandPluginRoot', () => {
  it('falls back to __dirname-based probing when env var is unset', () => {
    // With env unset, the env-honouring resolver still probes from the file's
    // location and substitutes a real plugin root, so the placeholder is
    // expanded (no longer a no-op). The substituted root must end in the
    // canonical plugin layout marker.
    const orig = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const out = expandPluginRoot('$CLAUDE_PLUGIN_ROOT/x.js');
      assert.notEqual(out, '$CLAUDE_PLUGIN_ROOT/x.js');
      assert.ok(out.endsWith('/x.js'), `expected suffix /x.js, got: ${out}`);
    } finally {
      if (orig !== undefined) process.env.CLAUDE_PLUGIN_ROOT = orig;
    }
  });

  it('expands $CLAUDE_PLUGIN_ROOT', () => {
    const orig = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/abs/plugin';
    try {
      assert.equal(expandPluginRoot('$CLAUDE_PLUGIN_ROOT/x.js'), '/abs/plugin/x.js');
      assert.equal(expandPluginRoot('${CLAUDE_PLUGIN_ROOT}/y.js'), '/abs/plugin/y.js');
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = orig;
    }
  });
});

describe('agent-authorization: extractSubCommand / isSafeSubCommand', () => {
  it('extracts the first non-flag arg after script for non-workflow-state', () => {
    // command segment: "node work-state.js get arg1"
    const cmd = 'node work-state.js get arg1';
    const matches = [...cmd.matchAll(new RegExp('(?:^|\\s)(node)\\s+(\\S+)', 'g'))];
    // Use a synthetic match index/length pointing past "node work-state.js"
    const match = { index: 0, 0: 'node work-state.js' };
    const sub = extractSubCommand(cmd, match, 'work-state.js');
    assert.equal(sub, 'get');
  });

  it('extracts the second non-flag arg for workflow-state.js', () => {
    const cmd = 'node workflow-state.js work get GH-1';
    const match = { index: 0, 0: 'node workflow-state.js' };
    const sub = extractSubCommand(cmd, match, 'workflow-state.js');
    assert.equal(sub, 'get');
  });

  it('strips surrounding quotes from sub-command', () => {
    const cmd = 'node work-state.js "get" arg';
    const match = { index: 0, 0: 'node work-state.js' };
    const sub = extractSubCommand(cmd, match, 'work-state.js');
    assert.equal(sub, 'get');
  });

  it('isSafeSubCommand checks against the SAFE_SUBCOMMANDS map', () => {
    const safeMap = {
      'work-state.js': new Set(['get', 'init']),
    };
    assert.equal(isSafeSubCommand('work-state.js', 'get', safeMap), true);
    assert.equal(isSafeSubCommand('work-state.js', 'set-step', safeMap), false);
    // Non-state scripts are not gated by safeMap
    assert.equal(isSafeSubCommand('other.js', 'anything', safeMap), true);
  });
});

describe('agent-authorization: isExemptScriptInvocation', () => {
  const exemptScripts = new Set(['workflow-engine.js', 'work-state.js']);
  const safeMap = {
    'work-state.js': new Set(['get', 'init']),
  };
  // Trust the directory where this test file lives
  const trustedDirs = [path.resolve(__dirname, '..')];

  // Real file under trusted dir to satisfy realpathSync check
  const realScript = path.resolve(__dirname, '..', 'agent-authorization.js');

  it('returns false when no node invocations present', () => {
    const r = isExemptScriptInvocation('ls -la', {
      exemptScripts,
      safeSubcommands: safeMap,
      trustedDirs,
      protectedBasenames: new Set(),
    });
    assert.equal(r, false);
  });

  it('returns false when command directly references a protected basename', () => {
    const r = isExemptScriptInvocation(`echo "x" > .work-state.json`, {
      exemptScripts,
      safeSubcommands: safeMap,
      trustedDirs,
      protectedBasenames: new Set(['.work-state.json']),
    });
    assert.equal(r, false);
  });

  it('returns false when invoked script is not in exempt list', () => {
    const r = isExemptScriptInvocation(`node ${realScript}`, {
      exemptScripts: new Set(),
      safeSubcommands: safeMap,
      trustedDirs,
      protectedBasenames: new Set(),
    });
    assert.equal(r, false);
  });

  it('returns false when script is exempt by basename but lives outside trusted dirs', () => {
    // /tmp file with the exempt basename should NOT be trusted
    const tmpFile = path.join(os.tmpdir(), `workflow-engine.js`);
    fs.writeFileSync(tmpFile, '// hi\n');
    try {
      const r = isExemptScriptInvocation(`node ${tmpFile}`, {
        exemptScripts,
        safeSubcommands: safeMap,
        trustedDirs,
        protectedBasenames: new Set(),
      });
      assert.equal(r, false);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

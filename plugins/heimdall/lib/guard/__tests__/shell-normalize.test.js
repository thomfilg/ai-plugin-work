// Unit tests for the shell-obfuscation normalizer shared by both guards (GH-655).
//
// Discovered by plugins/work/scripts/run-tests.sh.
// Manual: node --test plugins/heimdall/lib/guard/__tests__/shell-normalize.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  dequote,
  reduceSingleCharClasses,
  expandBraces,
  normalizedVariants,
  commandGlobReferencesMarker,
  commandGlobReferencesPath,
} = require(path.resolve(__dirname, '..', 'shell-normalize'));

describe('dequote', () => {
  it('collapses empty quote splits', () => {
    assert.equal(dequote('.cl""aude'), '.claude');
    assert.equal(dequote(".cl''aude"), '.claude');
  });
  it('removes backslash escapes', () => {
    assert.equal(dequote('.cla\\ude'), '.claude');
  });
  it('keeps quoted content', () => {
    assert.equal(dequote('cat "/a/.claude/x"'), 'cat /a/.claude/x');
  });
});

describe('reduceSingleCharClasses', () => {
  it('reduces single-char classes to the literal', () => {
    assert.equal(reduceSingleCharClasses('.c[l]aude'), '.claude');
    assert.equal(reduceSingleCharClasses('secret-fold[e]r'), 'secret-folder');
  });
  it('leaves negated and multi-char classes for glob matching', () => {
    assert.equal(reduceSingleCharClasses('.c[^x]aude'), '.c[^x]aude');
    assert.equal(reduceSingleCharClasses('.c[la]ude'), '.c[la]ude');
  });
});

describe('expandBraces', () => {
  it('enumerates brace alternatives', () => {
    assert.deepEqual(expandBraces('.{cl,x}aude').sort(), ['.claude', '.xaude'].sort());
  });
  it('is a no-op without a comma list', () => {
    assert.deepEqual(expandBraces('.claude'), ['.claude']);
  });
});

describe('normalizedVariants', () => {
  it('recovers the literal path across quote/brace/class evasions', () => {
    for (const cmd of [
      'cat ~/.c[l]aude/secret',
      'cat ~/.cl""aude/secret',
      'cat ~/.cla\\ude/secret',
      'cat ~/.{cl,x}aude/secret',
    ]) {
      assert.ok(
        normalizedVariants(cmd).some((v) => v.includes('.claude')),
        `expected a variant of ${cmd} to contain .claude`
      );
    }
  });
});

describe('commandGlobReferencesMarker', () => {
  it('matches an anchored wildcard token onto a bare marker', () => {
    assert.ok(commandGlobReferencesMarker('echo x > secretd*/y', 'secretdir'));
    assert.ok(commandGlobReferencesMarker('cat .cl*ude/y', '.claude'));
  });
  it('does not let a bare/unanchored wildcard match a short marker', () => {
    assert.ok(!commandGlobReferencesMarker('ls src/*', 'ui'));
    assert.ok(!commandGlobReferencesMarker('rm *.log', 'ui'));
    assert.ok(!commandGlobReferencesMarker('pnpm build', 'ui'));
  });
});

describe('commandGlobReferencesPath', () => {
  const dir = '/home/u/.claude';
  it('matches a wildcard token that resolves onto the dir or a child', () => {
    assert.ok(commandGlobReferencesPath('echo x > /home/u/.cl*ude/s', dir));
    assert.ok(commandGlobReferencesPath('echo x > /home/u/.claude/s', dir) === false); // no glob → not counted here
  });
  it('ignores unrelated globs', () => {
    assert.ok(!commandGlobReferencesPath('rm /home/u/tmp/*.log', dir));
    assert.ok(!commandGlobReferencesPath('ls src/*', dir));
  });
});

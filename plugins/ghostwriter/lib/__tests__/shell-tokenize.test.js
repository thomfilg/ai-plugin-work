/**
 * Unit tests for lib/shell-tokenize.js — the quote-aware reader every scanner
 * is built on.
 *
 * The property that matters most is that a quoted run is copied VERBATIM,
 * newlines included: it is the only reason a heredoc body inside
 * `"$(cat <<'EOF' … EOF)"` ever reaches the attribution rules.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/shell-tokenize.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { tokenize, longFlagValue } = require('../shell-tokenize');

describe('tokenize', () => {
  it('splits on control operators outside quotes', () => {
    assert.deepEqual(tokenize('npm test && git status'), [
      ['npm', 'test'],
      ['git', 'status'],
    ]);
    assert.deepEqual(tokenize('a; b | c'), [['a'], ['b'], ['c']]);
  });

  it('keeps operators that live inside quotes', () => {
    assert.deepEqual(tokenize('echo "a && b"'), [['echo', 'a && b']]);
    assert.deepEqual(tokenize("echo 'x; y'"), [['echo', 'x; y']]);
  });

  it('keeps newlines inside a quoted message', () => {
    const [segment] = tokenize('git commit -m "line one\n\nline two"');
    assert.deepEqual(segment, ['git', 'commit', '-m', 'line one\n\nline two']);
  });

  it('keeps a heredoc body that rides inside a quoted substitution', () => {
    const command = 'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nfooter\nEOF\n)"';
    const [segment] = tokenize(command);
    assert.ok(segment[3].includes('footer'), 'heredoc body must survive tokenizing');
  });

  it('honours backslash escapes and unterminated quotes', () => {
    assert.deepEqual(tokenize('echo a\\ b'), [['echo', 'a b']]);
    assert.deepEqual(tokenize('echo "unterminated'), [['echo', 'unterminated']]);
  });
});

describe('longFlagValue', () => {
  it('reads both --flag=value and --flag value', () => {
    assert.equal(longFlagValue(['--body=hi'], 0, '--body'), 'hi');
    assert.equal(longFlagValue(['--body', 'hi'], 0, '--body'), 'hi');
  });

  it('returns null for a different flag or a missing value', () => {
    assert.equal(longFlagValue(['--title', 'x'], 0, '--body'), null);
    assert.equal(longFlagValue(['--body'], 0, '--body'), null);
  });
});

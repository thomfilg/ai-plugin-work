'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { expandHome, safeJoin, validateIdentifier } = require('../pathSafe');

describe('expandHome', () => {
  it('expands "~" alone to the home directory', () => {
    assert.equal(expandHome('~'), os.homedir());
  });

  it('expands "~/x"', () => {
    assert.equal(expandHome('~/x'), `${os.homedir()}/x`);
  });

  it('expands "$HOME/x"', () => {
    assert.equal(expandHome('$HOME/x'), `${os.homedir()}/x`);
  });

  it('expands "${HOME}/x"', () => {
    assert.equal(expandHome('${HOME}/x'), `${os.homedir()}/x`);
  });

  it('leaves "~user/x" untouched', () => {
    assert.equal(expandHome('~alice/x'), '~alice/x');
  });

  it('leaves mid-string markers untouched', () => {
    assert.equal(expandHome('a/~/b'), 'a/~/b');
    assert.equal(expandHome('echo $HOME/x'), 'echo $HOME/x');
  });

  it('leaves near-miss prefixes untouched', () => {
    assert.equal(expandHome('$HOMESTEAD/x'), '$HOMESTEAD/x');
    assert.equal(expandHome('~x'), '~x');
  });

  it('returns falsy input unchanged', () => {
    assert.equal(expandHome(''), '');
    assert.equal(expandHome(null), null);
    assert.equal(expandHome(undefined), undefined);
  });

  it('resolves the home directory per call, not at module load', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX-only HOME semantics');
      return;
    }
    const original = process.env.HOME;
    try {
      process.env.HOME = '/tmp/path-safe-home-one';
      assert.equal(expandHome('~/x'), '/tmp/path-safe-home-one/x');
      process.env.HOME = '/tmp/path-safe-home-two';
      assert.equal(expandHome('~/x'), '/tmp/path-safe-home-two/x');
    } finally {
      process.env.HOME = original;
    }
  });
});

describe('safeJoin', () => {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safe-'));
  after(() => fs.rmSync(tempBase, { recursive: true, force: true }));

  it('returns the resolved path for a legitimate nested join', () => {
    const joined = safeJoin(tempBase, 'a', 'b.txt');
    assert.equal(joined, path.join(path.resolve(tempBase), 'a', 'b.txt'));
  });

  it('allows internal ".." hops that stay inside the base', () => {
    const joined = safeJoin(tempBase, 'a/../b');
    assert.equal(joined, path.join(path.resolve(tempBase), 'b'));
  });

  it('throws on traversal escaping the base', () => {
    assert.throws(() => safeJoin(tempBase, '../escape'), /pathSafe: .*not strictly inside/);
    assert.throws(() => safeJoin(tempBase, 'a', '../../escape'), /pathSafe:/);
  });

  it('throws when the result equals the base', () => {
    assert.throws(() => safeJoin(tempBase), /pathSafe:/);
    assert.throws(() => safeJoin(tempBase, '.'), /pathSafe:/);
    assert.throws(() => safeJoin(tempBase, 'a', '..'), /pathSafe:/);
  });

  it('rejects the prefix-sibling attack (/base vs /base-extra)', () => {
    assert.throws(
      () => safeJoin('/tmp/x/base', '../base-extra'),
      (err) => {
        assert.match(err.message, /pathSafe:/);
        assert.match(err.message, /\/tmp\/x\/base-extra/);
        assert.match(err.message, /\/tmp\/x\/base/);
        return true;
      }
    );
  });

  it('throws when an absolute segment replaces the base', () => {
    assert.throws(() => safeJoin(tempBase, '/etc/passwd'), /pathSafe:/);
  });

  it('names both paths in the violation message', () => {
    assert.throws(
      () => safeJoin(tempBase, '..'),
      (err) => {
        assert.ok(err.message.includes(path.resolve(tempBase)), 'message names the base');
        assert.ok(
          err.message.includes(path.dirname(path.resolve(tempBase))),
          'message names the result'
        );
        return true;
      }
    );
  });

  it('throws TypeError on non-string base or segments', () => {
    assert.throws(() => safeJoin(null, 'x'), TypeError);
    assert.throws(() => safeJoin('', 'x'), TypeError);
    assert.throws(() => safeJoin(tempBase, 42), TypeError);
  });
});

describe('validateIdentifier', () => {
  it('returns null for valid identifiers', () => {
    for (const id of ['ABC-123', 'TOPIC-9/phase1', 'a_b', 'x.y', 'part/sub_part']) {
      assert.equal(validateIdentifier(id), null, `"${id}" should be valid`);
    }
  });

  it('rejects non-string input', () => {
    for (const bad of [null, undefined, 42, true, {}, []]) {
      const err = validateIdentifier(bad);
      assert.ok(err, `${JSON.stringify(bad)} should be rejected`);
      assert.equal(err.code, 'INVALID_IDENTIFIER');
      assert.ok(Array.isArray(err.remediation) && err.remediation.length > 0);
    }
  });

  it('rejects empty and whitespace-only strings', () => {
    for (const bad of ['', '   ', '\t', '\n']) {
      assert.equal(validateIdentifier(bad)?.code, 'INVALID_IDENTIFIER');
    }
  });

  it('rejects padded identifiers', () => {
    for (const bad of [' abc', 'abc ', ' abc ', '\tabc']) {
      const err = validateIdentifier(bad);
      assert.equal(err?.code, 'INVALID_IDENTIFIER');
      assert.match(err.message, /whitespace/);
    }
  });

  it('rejects traversal, backslash, colon, and null bytes', () => {
    for (const bad of ['../x', 'a..b', 'a/..', 'a\\b', 'a:b', 'a\0b', '..']) {
      const err = validateIdentifier(bad);
      assert.equal(err?.code, 'INVALID_IDENTIFIER', `"${bad}" should be rejected`);
      assert.match(err.message, /unsafe sequence/);
    }
  });

  it('rejects bare dot segments and leading slashes', () => {
    assert.equal(validateIdentifier('.')?.code, 'INVALID_IDENTIFIER');
    assert.equal(validateIdentifier('./')?.code, 'INVALID_IDENTIFIER');
    assert.equal(validateIdentifier('/abs')?.code, 'INVALID_IDENTIFIER');
  });

  it('rejects more than one slash and bad suffixes', () => {
    assert.match(validateIdentifier('a/b/c').message, /at most one/);
    assert.match(validateIdentifier('a/').message, /suffix/);
    assert.match(validateIdentifier('a/.').message, /suffix/);
  });

  it('applies opts.allow to each slash-separated part', () => {
    const allow = /^[a-z0-9_]+$/;
    assert.equal(validateIdentifier('abc/def_1', { allow }), null);
    assert.match(validateIdentifier('abc/DEF', { allow }).message, /allow/);
    assert.match(validateIdentifier('ABC', { allow }).message, /allow/);
  });

  it('is not confused by a global-flagged allow pattern', () => {
    const allow = /^[a-z]+$/g;
    assert.equal(validateIdentifier('abc/abc', { allow }), null);
    assert.equal(validateIdentifier('abc/abc', { allow }), null);
  });

  it('throws TypeError when opts.allow is not a RegExp', () => {
    assert.throws(() => validateIdentifier('abc', { allow: 'abc' }), /"allow" must be a RegExp/);
  });
});

describe('parity self-test against the in-repo structured validator', () => {
  it('produces the same valid/invalid verdicts', () => {
    const fixture = path.resolve(
      __dirname,
      '../../../plugins/work/scripts/workflows/lib/ticket-validation.js'
    );
    if (!fs.existsSync(fixture)) return; // stand-alone checkout — skip

    const { validateTicketIdStructured } = require(fixture);
    const table = [
      'ABC-123',
      'ABC-123/phase1',
      'PROJ-1/task_2',
      'a/b/c',
      '../x',
      'a..b',
      'a\\b',
      'a:b',
      'a\0b',
      ' padded ',
      '',
      '   ',
      '.',
      './',
      '/abs',
      'x/',
      'x/.',
      null,
      undefined,
      42,
    ];
    for (const id of table) {
      const expected = validateTicketIdStructured(id) === null;
      const actual = validateIdentifier(id) === null;
      assert.equal(
        actual,
        expected,
        `verdict mismatch for ${JSON.stringify(typeof id === 'string' ? id : String(id))}`
      );
    }
  });
});

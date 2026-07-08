/**
 * Tests for rules/adjacent-assertions.js — consecutive duplicate assertion
 * detector (the wrapped-vs-unwrapped merge-artifact rule).
 *
 * Run: node --test plugins/work/scripts/workflows/lib/scripts/quality/__tests__/adjacent-assertions.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkAll } = require('../rules/adjacent-assertions');

let dir;

function writeFixture(name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('adjacent-assertions rule', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adj-assert-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags an identical assertion repeated on the next line', () => {
    const f = writeFixture(
      'dup.test.js',
      [
        "assert.match(out, /export HEIMDALL_PROTECTED='\\/repo';/);",
        "assert.match(out, /export HEIMDALL_PROTECTED='\\/repo';/);",
      ].join('\n')
    );
    const v = checkAll([f], dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, 'duplicate-adjacent-assertions');
    assert.equal(v[0].severity, 'error');
    assert.equal(v[0].line, 2);
    assert.match(v[0].message, /line 1/);
  });

  it('flags the wrapped + single-line pair (the merge-artifact shape)', () => {
    const f = writeFixture(
      'wrapped.test.js',
      [
        'it("x", () => {',
        "  assert.match(out, /export LD_PRELOAD='\\/x\\/fsguard\\.so';/);",
        '  assert.match(',
        '    out,',
        "    /export LD_PRELOAD='\\/x\\/fsguard\\.so';/",
        '  );',
        '});',
      ].join('\n')
    );
    const v = checkAll([f], dir);
    assert.equal(v.length, 1, JSON.stringify(v));
    assert.equal(v[0].line, 3);
  });

  it('flags a duplicate pair separated only by a blank line', () => {
    const f = writeFixture(
      'blank.test.js',
      ['assert.equal(a, 1);', '', 'assert.equal(a, 1);'].join('\n')
    );
    const v = checkAll([f], dir);
    assert.equal(v.length, 1);
  });

  it('does NOT flag identical assertions separated by other code', () => {
    const f = writeFixture(
      'separated.test.js',
      ['assert.equal(count(), 1);', 'doThing();', 'assert.equal(count(), 1);'].join('\n')
    );
    assert.deepEqual(checkAll([f], dir), []);
  });

  it('does NOT flag assertions differing only inside a string literal', () => {
    const f = writeFixture(
      'string-ws.test.js',
      ["assert.equal(classify(''), 'unknown');", "assert.equal(classify('   '), 'unknown');"].join(
        '\n'
      )
    );
    assert.deepEqual(checkAll([f], dir), []);
  });

  it('does NOT flag an intentional repeat documented by a comment between', () => {
    const f = writeFixture(
      'intentional.test.js',
      [
        'assert.equal(validateIdentifier("abc", { allow }), null);',
        '// repeated on purpose: /g regex lastIndex must not leak into the second call',
        'assert.equal(validateIdentifier("abc", { allow }), null);',
      ].join('\n')
    );
    assert.deepEqual(checkAll([f], dir), []);
  });

  it('does NOT flag different adjacent assertions', () => {
    const f = writeFixture(
      'different.test.js',
      ['assert.equal(a, 1);', 'assert.equal(b, 2);'].join('\n')
    );
    assert.deepEqual(checkAll([f], dir), []);
  });

  it('does NOT flag adjacent identical non-assertion statements', () => {
    const f = writeFixture('calls.test.js', ['retryOnce();', 'retryOnce();'].join('\n'));
    assert.deepEqual(checkAll([f], dir), []);
  });

  it('handles expect()-style assertions', () => {
    const f = writeFixture(
      'expect.test.js',
      ['expect(out).toContain("x");', 'expect(out).toContain("x");'].join('\n')
    );
    assert.equal(checkAll([f], dir).length, 1);
  });

  it('ignores non-JS files and unreadable paths', () => {
    const md = writeFixture('notes.md', 'assert.equal(a, 1);\nassert.equal(a, 1);');
    assert.deepEqual(checkAll([md, path.join(dir, 'missing.js')], dir), []);
  });

  it('reports repo-relative POSIX paths', () => {
    const sub = path.join(dir, 'nested');
    fs.mkdirSync(sub);
    const f = path.join(sub, 'p.test.js');
    fs.writeFileSync(f, 'assert.ok(x);\nassert.ok(x);');
    const v = checkAll([f], dir);
    assert.equal(v[0].file, 'nested/p.test.js');
  });
});

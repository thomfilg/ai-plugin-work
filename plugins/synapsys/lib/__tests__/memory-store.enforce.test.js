'use strict';

// GH-520: frontmatter normalization of the enforce fields in memory-store.js.
// `enforce` defaults to 'advise' and anything unknown normalizes to 'advise'
// with a stderr warning; `enforce_classifier` / `enforce_satisfied_by` surface
// as trimmed scalar strings.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-enforce-store-'));
  fs.writeFileSync(path.join(dir, '.synapsys.json'), JSON.stringify({ projectName: 'test' }));
  return { kind: 'local', dir, projectName: 'test' };
}

function writeMemory(store, name, fmLines) {
  fs.writeFileSync(
    path.join(store.dir, `${name}.md`),
    `---\nname: ${name}\nevents: PreToolUse\ntrigger_pretool: Bash:x\n${fmLines.join('\n')}\n---\nbody\n`
  );
}

function readOne(store, name) {
  const m = listMemoriesFromStore(store).find((x) => x.name === name);
  assert.ok(m, `memory ${name} should load`);
  return m;
}

describe('memory-store enforce normalization (GH-520)', () => {
  let store;

  beforeEach(() => {
    store = makeStore();
  });

  it('defaults to advise when enforce is absent', () => {
    writeMemory(store, 'plain', []);
    assert.equal(readOne(store, 'plain').enforce, 'advise');
  });

  it('parses the three valid enforce values', () => {
    writeMemory(store, 'adv', ['enforce: advise']);
    writeMemory(store, 'sug', ['enforce: suggest']);
    writeMemory(store, 'blk', ['enforce: block']);
    assert.equal(readOne(store, 'adv').enforce, 'advise');
    assert.equal(readOne(store, 'sug').enforce, 'suggest');
    assert.equal(readOne(store, 'blk').enforce, 'block');
  });

  it('normalizes unknown enforce values to advise (fail-open) with a stderr warning', () => {
    writeMemory(store, 'typo', ['enforce: blocc']);
    const warnings = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => {
      warnings.push(String(s));
      return true;
    };
    let m;
    try {
      m = readOne(store, 'typo');
    } finally {
      process.stderr.write = orig;
    }
    assert.equal(m.enforce, 'advise');
    assert.ok(
      warnings.some((w) => w.includes('invalid enforce "blocc"')),
      `expected an invalid-enforce warning, got: ${JSON.stringify(warnings)}`
    );
  });

  it('normalizes boolean-coerced enforce values (enforce: true) to advise', () => {
    writeMemory(store, 'boolval', ['enforce: true']);
    const orig = process.stderr.write;
    process.stderr.write = () => true;
    try {
      assert.equal(readOne(store, 'boolval').enforce, 'advise');
    } finally {
      process.stderr.write = orig;
    }
  });

  it('surfaces enforce_classifier and enforce_satisfied_by as trimmed scalars', () => {
    writeMemory(store, 'cls', [
      'enforce: block',
      'enforce_classifier: first-edit-of-session',
      'enforce_satisfied_by: cortex_recall',
    ]);
    const m = readOne(store, 'cls');
    assert.equal(m.enforceClassifier, 'first-edit-of-session');
    assert.equal(m.enforceSatisfiedBy, 'cortex_recall');
  });

  it('missing classifier fields normalize to empty strings', () => {
    writeMemory(store, 'noc', ['enforce: block']);
    const m = readOne(store, 'noc');
    assert.equal(m.enforceClassifier, '');
    assert.equal(m.enforceSatisfiedBy, '');
  });
});

'use strict';

// Unit tests for lib/enforce-classifiers.js (GH-520): the symbol-shape pattern
// extraction/verdict rules and the first-edit-of-session state machine.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  symbolShape,
  firstEditOfSession,
  observePreTool,
  extractSearchTarget,
  getClassifier,
  CLASSIFIER_NAMES,
} = require('../enforce-classifiers');

function grep(pattern, extra = {}) {
  return { tool_name: 'Grep', tool_input: { pattern, ...extra } };
}

function bash(command) {
  return { tool_name: 'Bash', tool_input: { command } };
}

describe('registry', () => {
  it('exposes exactly the two built-in classifiers', () => {
    assert.deepEqual(CLASSIFIER_NAMES.sort(), ['first-edit-of-session', 'symbol-shape']);
    assert.equal(typeof getClassifier('symbol-shape'), 'function');
    assert.equal(getClassifier('nope'), null);
  });
});

describe('symbol-shape', () => {
  it('blocks a bare identifier Grep pattern', () => {
    assert.equal(symbolShape({}, grep('getUserData')), 'block');
    assert.equal(symbolShape({}, grep('_private_thing')), 'block');
    assert.equal(symbolShape({}, grep('snake_case_name')), 'block');
  });

  it('allows non-identifier shapes (spaces, quotes, slashes, regex metachars)', () => {
    for (const p of [
      'get user data',
      'get.*Data',
      '\\bgetUserData\\b',
      'foo|bar',
      'a/b/c',
      'name(arg)',
      'x[0]',
      '"quoted"',
      'user$Data', // $ is identifier-legal but a regex anchor — conservative allow
      '^anchor',
      'tail$',
    ]) {
      assert.equal(symbolShape({}, grep(p)), 'allow', `pattern ${p} must allow`);
    }
  });

  it('allows length outliers and stoplist words', () => {
    assert.equal(symbolShape({}, grep('ab')), 'allow'); // < 3
    assert.equal(symbolShape({}, grep('a'.repeat(51))), 'allow'); // > 50
    for (const p of ['TODO', 'FIXME', 'README', 'NOTE', 'XXX', 'todo']) {
      assert.equal(symbolShape({}, grep(p)), 'allow', `stoplist ${p} must allow`);
    }
  });

  it('allows identifier greps whose targets include .md, .claude/, or node_modules', () => {
    assert.equal(symbolShape({}, grep('getUserData', { path: 'docs/readme.md' })), 'allow');
    assert.equal(symbolShape({}, grep('getUserData', { glob: '.claude/**' })), 'allow');
    assert.equal(symbolShape({}, grep('getUserData', { path: 'node_modules/pkg' })), 'allow');
    assert.equal(symbolShape({}, grep('getUserData', { path: 'src' })), 'block');
  });

  it('extracts the first non-flag arg after a grep/rg invocation in Bash', () => {
    assert.deepEqual(extractSearchTarget(bash('rg -n getUserData src/')), {
      pattern: 'getUserData',
      args: ['-n', 'src/'],
    });
    assert.deepEqual(extractSearchTarget(bash('grep -rn "get user" src')), {
      pattern: 'get user',
      args: ['-rn', 'src'],
    });
    // Piped invocation still found.
    assert.equal(extractSearchTarget(bash('cat x | grep foobar')).pattern, 'foobar');
    // No grep/rg → null (allow).
    assert.equal(extractSearchTarget(bash('ls -la')), null);
    assert.equal(symbolShape({}, bash('ls -la')), 'allow');
  });

  it('applies verdicts to Bash grep/rg invocations', () => {
    assert.equal(symbolShape({}, bash('rg -n getUserData src/')), 'block');
    assert.equal(symbolShape({}, bash('grep -rn "get.*Data" src/')), 'allow');
    assert.equal(symbolShape({}, bash('grep getUserData docs/notes.md')), 'allow');
    assert.equal(symbolShape({}, bash('rg --include=*.md getUserData')), 'allow');
  });

  it('allows unknown tools and malformed inputs (conservative)', () => {
    assert.equal(symbolShape({}, { tool_name: 'Read', tool_input: { file_path: 'x' } }), 'allow');
    assert.equal(symbolShape({}, {}), 'allow');
    assert.equal(symbolShape({}, { tool_name: 'Grep', tool_input: {} }), 'allow');
    assert.equal(symbolShape({}, { tool_name: 'Grep', tool_input: { pattern: 42 } }), 'allow');
  });
});

describe('first-edit-of-session', () => {
  let sessionDir;
  const memory = { enforceSatisfiedBy: 'cortex_recall' };

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-enforce-state-'));
    process.env.SYNAPSYS_SESSION_DIR = sessionDir;
  });

  function edit(sessionId) {
    return firstEditOfSession(memory, { tool_name: 'Edit', tool_input: {} }, { sessionId });
  }

  it('blocks the first edit when no satisfier was observed', () => {
    assert.equal(edit('s1'), 'block');
  });

  it('allows non-edit tools unconditionally', () => {
    assert.equal(
      firstEditOfSession(memory, { tool_name: 'Bash', tool_input: {} }, { sessionId: 's1' }),
      'allow'
    );
  });

  it('allows once the satisfier tool name has been observed', () => {
    observePreTool('s2', { tool_name: 'mcp__cortex__cortex_recall', tool_input: {} });
    assert.equal(edit('s2'), 'allow');
  });

  it('is a first-edit gate: after the first edit is observed, later edits allow', () => {
    assert.equal(edit('s3'), 'block');
    observePreTool('s3', { tool_name: 'Edit', tool_input: {} }); // dispatcher observes the same call
    assert.equal(edit('s3'), 'allow');
  });

  it('a memory with no enforce_satisfied_by blocks the first edit unconditionally', () => {
    observePreTool('s4', { tool_name: 'mcp__cortex__cortex_recall', tool_input: {} });
    assert.equal(
      firstEditOfSession({}, { tool_name: 'Write', tool_input: {} }, { sessionId: 's4' }),
      'block'
    );
  });

  it('an invalid enforce_satisfied_by regex fails open to allow', () => {
    assert.equal(
      firstEditOfSession(
        { enforceSatisfiedBy: '(unclosed' },
        { tool_name: 'Edit', tool_input: {} },
        { sessionId: 's5' }
      ),
      'allow'
    );
  });

  it('state is isolated per session id', () => {
    observePreTool('s6', { tool_name: 'Edit', tool_input: {} });
    assert.equal(edit('s6'), 'allow'); // s6 already saw its first edit
    assert.equal(edit('s7'), 'block'); // s7 has not
  });
});

'use strict';

/**
 * split-in-tasks-skill-doc — documentation assertion tests.
 *
 * Asserts that the Split-Warning Passes documentation (now in
 * docs/split-warning-passes.md after the GH-485 docs refactor) contains
 * Pass A, Pass B, Pass C, the SPLIT-WARNING token, and per-pass
 * limitations. Also asserts SKILL.md cross-references the sub-doc.
 *
 * Requirements covered: R6 (SKILL.md update), R8 (operator hint),
 * R11 (no $HOME paths).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_MD_PATH = path.join(__dirname, '..', 'SKILL.md');
const SPLIT_WARNING_DOC_PATH = path.join(__dirname, '..', 'docs', 'split-warning-passes.md');

function readSkillMd() {
  return fs.readFileSync(SKILL_MD_PATH, 'utf8');
}

function readSplitWarningDoc() {
  return fs.readFileSync(SPLIT_WARNING_DOC_PATH, 'utf8');
}

test('Split-Warning Passes doc contains a top-level section', () => {
  const content = readSplitWarningDoc();
  assert.match(
    content,
    /^#\s+Split-Warning Passes\b/m,
    'expected a top-level "# Split-Warning Passes" section in docs/split-warning-passes.md'
  );
});

test('Split-Warning Passes doc documents Pass A, Pass B, and Pass C', () => {
  const content = readSplitWarningDoc();
  assert.match(content, /\bPass A\b/, 'expected mention of "Pass A"');
  assert.match(content, /\bPass B\b/, 'expected mention of "Pass B"');
  assert.match(content, /\bPass C\b/, 'expected mention of "Pass C"');
});

test('Split-Warning Passes doc mentions the SPLIT-WARNING token', () => {
  const content = readSplitWarningDoc();
  assert.match(
    content,
    /SPLIT-WARNING/,
    'expected the warning token "SPLIT-WARNING" to appear in docs/split-warning-passes.md'
  );
});

test('Split-Warning Passes doc describes per-pass limitations', () => {
  const content = readSplitWarningDoc();
  assert.match(
    content,
    /[Ll]imitations?/,
    'expected the Split-Warning Passes doc to call out limitations'
  );
});

test('SKILL.md cross-references the Split-Warning Passes sub-doc', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /Split-Warning Passes|split-warning-passes/i,
    'expected SKILL.md to reference "Split-Warning Passes" (link or text)'
  );
});

test('Split-Warning Passes doc does not introduce $HOME-style absolute paths (R11)', () => {
  const content = readSplitWarningDoc();
  assert.doesNotMatch(
    content,
    /\$HOME\b|\/home\/[a-z]/i,
    'Split-Warning Passes doc must not embed $HOME or /home/<user> paths'
  );
});

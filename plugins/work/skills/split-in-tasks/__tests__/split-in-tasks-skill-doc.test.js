'use strict';

/**
 * split-in-tasks-skill-doc — documentation assertion tests.
 *
 * Asserts that SKILL.md contains the "Split-Warning Passes" section
 * with documentation for Pass A, Pass B, Pass C, the SPLIT-WARNING
 * token, and the per-pass limitations text. Also asserts the section
 * is linked from the table of contents / step list.
 *
 * Requirements covered: R6 (SKILL.md update), R8 (operator hint),
 * R11 (no $HOME paths).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_MD_PATH = path.join(__dirname, '..', 'SKILL.md');

function readSkillMd() {
  return fs.readFileSync(SKILL_MD_PATH, 'utf8');
}

test('SKILL.md contains a "Split-Warning Passes" top-level section', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /^##\s+Split-Warning Passes\b/m,
    'expected a top-level "## Split-Warning Passes" section'
  );
});

test('SKILL.md documents Pass A, Pass B, and Pass C', () => {
  const content = readSkillMd();
  assert.match(content, /\bPass A\b/, 'expected mention of "Pass A"');
  assert.match(content, /\bPass B\b/, 'expected mention of "Pass B"');
  assert.match(content, /\bPass C\b/, 'expected mention of "Pass C"');
});

test('SKILL.md mentions the SPLIT-WARNING token', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /SPLIT-WARNING/,
    'expected the warning token "SPLIT-WARNING" to appear in SKILL.md'
  );
});

test('SKILL.md describes per-pass limitations', () => {
  const content = readSkillMd();
  assert.match(
    content,
    /[Ll]imitations?/,
    'expected the "Split-Warning Passes" section to call out limitations'
  );
});

test('SKILL.md table of contents / step list links to the new section', () => {
  const content = readSkillMd();
  // Either a markdown anchor link or a plain-text reference earlier in the doc.
  const sectionIdx = content.search(/^##\s+Split-Warning Passes\b/m);
  assert.ok(sectionIdx > 0, 'section must exist before checking TOC link');
  const beforeSection = content.slice(0, sectionIdx);
  assert.match(
    beforeSection,
    /Split-Warning Passes|split-warning-passes/i,
    'expected the table of contents / step list (before the section) to reference "Split-Warning Passes"'
  );
});

test('SKILL.md does not introduce $HOME-style absolute paths (R11)', () => {
  const content = readSkillMd();
  const sectionMatch = content.match(/^##\s+Split-Warning Passes\b[\s\S]*?(?=^##\s|$(?![\s\S]))/m);
  if (!sectionMatch) {
    // Pre-RED: section absent — nothing to enforce yet.
    return;
  }
  assert.doesNotMatch(
    sectionMatch[0],
    /\$HOME\b|\/home\/[a-z]/i,
    'Split-Warning Passes section must not embed $HOME or /home/<user> paths'
  );
});

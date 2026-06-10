'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  extractField,
  parseSuggestedScope,
  findTestFilesInScope,
} = require('../task-next.js');

const BT = String.fromCharCode(96); // backtick, kept out of template literals
const TASK_NEXT_SRC = path.join(__dirname, '..', 'task-next.js');

test('extractField ignores in-prose backticked heading mentions', () => {
  const section = [
    '## Task 2',
    '',
    '### Acceptance Criteria',
    '- 2.1.2 GREEN mirror the BACKTICK### Files in scopeBACKTICK heading regex',
    '- 2.1.3 REFACTOR',
    '',
    '### Files in scope',
    '- BACKTICKplugins/work/lib/foo.jsBACKTICK',
    '- BACKTICKplugins/work/__tests__/foo.test.jsBACKTICK (NEW)',
    '',
    '### Test Command',
    '',
  ].join('\n').replace(/BACKTICK/g, BT);
  const scope = parseSuggestedScope(section);
  assert.deepEqual(scope, [
    'plugins/work/lib/foo.js',
    'plugins/work/__tests__/foo.test.js',
  ]);
});

test('extractField matches a heading at start-of-string', () => {
  const section = '### Files in scope\n- BACKTICKfoo/bar.jsBACKTICK\n\n### Test Command\n'.replace(/BACKTICK/g, BT);
  assert.equal(extractField(section, 'Files in scope').trim().includes('foo/bar.js'), true);
});

test('extractField does NOT match heading-like substring without leading newline', () => {
  const section = 'prefix BACKTICK### Files in scopeBACKTICK inline\n### Other\n'.replace(/BACKTICK/g, BT);
  assert.equal(extractField(section, 'Files in scope'), '');
});

test('parseSuggestedScope: when BOTH headings are present, `Files in scope` wins (canonical per spec Open Q #3)', () => {
  const section = [
    '## Task 7',
    '',
    '### Suggested Scope',
    '- BACKTICKlegacy/old-path.jsBACKTICK',
    '- BACKTICKlegacy/other.jsBACKTICK',
    '',
    '### Files in scope',
    '- BACKTICKcanonical/new-path.jsBACKTICK',
    '- BACKTICKcanonical/new-test.test.jsBACKTICK',
    '',
    '### Test Command',
    '',
  ].join('\n').replace(/BACKTICK/g, BT);
  const scope = parseSuggestedScope(section);
  assert.deepEqual(
    scope,
    ['canonical/new-path.js', 'canonical/new-test.test.js'],
    '`Files in scope` is the canonical heading and must override `Suggested Scope` when both are present',
  );
});

// ---------------------------------------------------------------------------
// GH-491 Task 1 — regression lock for the GH-442 Task 2 shape + canonical
// block-reason wording. The parse/discovery blocks below PIN already-landed
// behavior so future re-narrowing of the scope parser is caught; the wording
// block drives the R4 string change (it fails until the five sites name the
// canonical `### Files in scope` section the gate actually scans).
// ---------------------------------------------------------------------------

// 1.1.1(a) — GH-442 Task 2 shape: the `*.test.js` is declared ONLY in the
// `### Files in scope` block while `### Suggested Scope` is narrow (no test
// file). parseSuggestedScope must still return the test path.
test('parseSuggestedScope returns the .test.js path when only `### Files in scope` lists it (GH-442 Task 2 shape)', () => {
  const section = [
    '## Task 2',
    '',
    '### Suggested Scope',
    '- BACKTICKplugins/work/lib/widget.jsBACKTICK',
    '',
    '### Files in scope',
    '- BACKTICKplugins/work/lib/widget.jsBACKTICK',
    '- BACKTICKplugins/work/lib/__tests__/widget.test.jsBACKTICK',
    '',
    '### Test Command',
    '',
  ].join('\n').replace(/BACKTICK/g, BT);
  const scope = parseSuggestedScope(section);
  assert.ok(
    scope.includes('plugins/work/lib/__tests__/widget.test.js'),
    'the *.test.js declared only in `### Files in scope` must be returned',
  );
});

// 1.1.1(b) — end-to-end: build a temp repo with a fixture source file plus a
// colocated *.test.js, run parseSuggestedScope then findTestFilesInScope, and
// assert the discovered set is non-empty and contains the test file.
test('parseSuggestedScope -> findTestFilesInScope discovers the *.test.js end-to-end (temp dir)', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh491-task1-'));
  try {
    const relDir = path.join('plugins', 'work', 'lib');
    fs.mkdirSync(path.join(repoRoot, relDir), { recursive: true });
    const srcRel = path.join(relDir, 'widget.js');
    const testRel = path.join(relDir, 'widget.test.js');
    fs.writeFileSync(path.join(repoRoot, srcRel), 'module.exports = {};\n');
    fs.writeFileSync(path.join(repoRoot, testRel), "require('node:test');\n");

    const section = [
      '## Task 2',
      '',
      '### Suggested Scope',
      '- BACKTICK' + srcRel + 'BACKTICK',
      '',
      '### Files in scope',
      '- BACKTICK' + srcRel + 'BACKTICK',
      '- BACKTICK' + testRel + 'BACKTICK',
      '',
      '### Test Command',
      '',
    ].join('\n').replace(/BACKTICK/g, BT);

    const scope = parseSuggestedScope(section);
    const discovered = findTestFilesInScope(repoRoot, scope);
    const discoveredArr = Array.from(discovered);

    assert.ok(discoveredArr.length > 0, 'discovery set must be non-empty');
    assert.ok(
      discoveredArr.some((p) => p === path.join(repoRoot, testRel)),
      'findTestFilesInScope must discover the *.test.js declared in `### Files in scope`',
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// 1.1.1(c) — backward-compat: a legacy section with ONLY `### Suggested Scope`
// (no `### Files in scope`) must still return its paths via the fallback.
test('parseSuggestedScope falls back to `### Suggested Scope` when `### Files in scope` is absent', () => {
  const section = [
    '## Task 9',
    '',
    '### Suggested Scope',
    '- BACKTICKlegacy/only-path.jsBACKTICK',
    '- BACKTICKlegacy/only-test.test.jsBACKTICK',
    '',
    '### Test Command',
    '',
  ].join('\n').replace(/BACKTICK/g, BT);
  const scope = parseSuggestedScope(section);
  assert.deepEqual(
    scope,
    ['legacy/only-path.js', 'legacy/only-test.test.js'],
    'legacy `### Suggested Scope`-only sections must still resolve their paths',
  );
});

// 1.1.1(d) — input-validation guard: an in-prose backticked `### Files in scope`
// mention must NOT be treated as the real heading; only the real block's paths
// are returned.
test('in-prose backticked `Files in scope` heading is ignored; only the real block resolves', () => {
  const section = [
    '## Task 4',
    '',
    '### Description',
    'This task mirrors the BACKTICK### Files in scopeBACKTICK heading regex behavior.',
    '',
    '### Files in scope',
    '- BACKTICKreal/path.jsBACKTICK',
    '- BACKTICKreal/path.test.jsBACKTICK',
    '',
    '### Test Command',
    '',
  ].join('\n').replace(/BACKTICK/g, BT);
  const scope = parseSuggestedScope(section);
  assert.deepEqual(
    scope,
    ['real/path.js', 'real/path.test.js'],
    'only the real `### Files in scope` block contributes paths; the in-prose mention is ignored',
  );
});

// 1.2.1 — canonical block-reason wording: the RED-gate block-reason / help-text
// strings must name `### Files in scope` (the section the gate actually scans)
// and must NOT direct the implementer to "Suggested Scope". Read from the
// module source because the reason-builder is internal (not exported).
test('RED-gate block-reason / help-text strings name `Files in scope`, never "Suggested Scope"', () => {
  const src = fs.readFileSync(TASK_NEXT_SRC, 'utf8');

  // Only inspect user-facing block-reason / help-text lines (those that push a
  // string the implementer reads), not parser-internal comments or the
  // extractField fallback call which legitimately references both headings.
  const userFacingLines = src
    .split('\n')
    .filter((line) => {
      const isReason = /blockReason\s*=/.test(line);
      const isHelpPush = /lines\.push\(/.test(line);
      const isFallbackLog = /RED accepted via unit-only fallback/.test(line);
      const isMissingMatch = /verbatim title match against test files/.test(line);
      return isReason || isHelpPush || isFallbackLog || isMissingMatch;
    });

  const offenders = userFacingLines.filter((line) => /Suggested Scope/.test(line));
  assert.deepEqual(
    offenders,
    [],
    'no user-facing block reason / help text may direct the implementer to "Suggested Scope"; they must name the canonical `Files in scope` section',
  );

  const namesCanonical = userFacingLines.some((line) => /Files in scope/.test(line));
  assert.ok(
    namesCanonical,
    'at least one user-facing block reason / help-text line must name the canonical `Files in scope` section',
  );
});

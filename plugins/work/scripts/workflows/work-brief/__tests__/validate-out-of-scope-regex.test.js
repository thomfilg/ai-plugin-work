'use strict';

/**
 * Regression test for the ECHO-4578 brief-validate regex bug.
 *
 * Previous regex used `\b` after `)`:
 *   /^##\s+Out of scope\s*\(sibling-owned\)\b/im
 * That never matched in JS because `)` and the next char (space/EOL) are
 * both non-word — \b requires a word/non-word transition. The slice
 * returned empty and the validator falsely reported every sibling ticket
 * as missing from the Out-of-scope section.
 *
 * The fix replaces `\b` with `(?=\s|$)`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateArtifacts } = require('../lib/phases/validate');

function makeTasksDir({ brief, overlap }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-validate-regex-'));
  const tasksDir = path.join(root, 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (brief) fs.writeFileSync(path.join(tasksDir, 'brief.md'), brief);
  if (overlap) fs.writeFileSync(path.join(tasksDir, 'sibling-overlap.md'), overlap);
  return { root, tasksDir };
}

const OVERLAP_WITH_SIBLINGS = [
  '# Sibling overlap',
  '',
  '## ECHO-4470',
  '**Verdict:** sibling-owned',
  '- some surface',
  '',
  '## ECHO-4567',
  '**Verdict:** sibling-owned',
  '- some surface',
  '',
].join('\n');

const BRIEF_VALID = [
  '# Brief',
  '',
  '## Out of scope (sibling-owned)',
  '- `ECHO-4470` owns the backend filter',
  '- `ECHO-4567` owns the frontend component',
  '',
  '## Success Metrics',
  '- foo',
  '',
].join('\n');

test('section heading is detected and sibling IDs are found (regression for ECHO-4578)', () => {
  const { root, tasksDir } = makeTasksDir({
    brief: BRIEF_VALID,
    overlap: OVERLAP_WITH_SIBLINGS,
  });
  const errors = validateArtifacts(tasksDir, ['ECHO-4470', 'ECHO-4567']);
  // Before the fix this returned errors saying both IDs were missing.
  assert.deepEqual(errors, [], `expected no errors, got: ${JSON.stringify(errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing sibling ID still reported (positive case)', () => {
  const { root, tasksDir } = makeTasksDir({
    brief: BRIEF_VALID, // only lists 4470 + 4567
    overlap: [
      OVERLAP_WITH_SIBLINGS,
      '## ECHO-4559',
      '**Verdict:** sibling-owned',
      '- some surface',
      '',
    ].join('\n'),
  });
  const errors = validateArtifacts(tasksDir, ['ECHO-4470', 'ECHO-4567', 'ECHO-4559']);
  assert.ok(
    errors.some((e) => e.includes('ECHO-4559')),
    `expected ECHO-4559 missing error, got: ${JSON.stringify(errors)}`
  );
  fs.rmSync(root, { recursive: true, force: true });
});

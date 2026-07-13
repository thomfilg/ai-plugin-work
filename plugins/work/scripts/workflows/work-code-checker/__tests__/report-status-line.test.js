'use strict';

/**
 * report phase — canonical **Status:** line requirement (echo-5219 issue 2 /
 * echo-5349 issue 3). A prose-only "## Overall Assessment: ✅ Well-Implemented"
 * report parsed UNKNOWN in downstream gates and looped the check step; the
 * report phase now requires a gate-readable status line.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const report = require('../lib/phases/report');

function makeTasksDir(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-report-status-'));
  const tasksDir = path.join(root, 'GH-282');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'code-review.check.md'), content);
  return { root, tasksDir };
}

const BASE_SECTIONS = [
  '## Overall Assessment: ✅ Well-Implemented',
  'Confidence: High',
  '',
  '## Policy Compliance Summary',
  '| Area | Status |',
  '| --- | --- |',
  '| Code Reuse | Pass |',
  '',
  '## Strengths',
  '## Issues Found',
  'None found.',
].join('\n');

test('validate passes when canonical **Status:** APPROVED line is present', () => {
  const { root, tasksDir } = makeTasksDir(`**Status:** APPROVED\n\n${BASE_SECTIONS}\n`);
  const res = report.validate({ ticket: 'GH-282', tasksDir });
  assert.equal(res.ok, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('validate blocks a prose-only report missing the canonical Status line', () => {
  const { root, tasksDir } = makeTasksDir(`${BASE_SECTIONS}\n`);
  const res = report.validate({ ticket: 'GH-282', tasksDir });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /canonical status line/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('validate blocks an invalid Status value for codeReview reports', () => {
  const { root, tasksDir } = makeTasksDir(`**Status:** COMPLETE\n\n${BASE_SECTIONS}\n`);
  const res = report.validate({ ticket: 'GH-282', tasksDir });
  assert.equal(res.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('instructions template includes the canonical Status line', () => {
  const text = report.instructions({ ticket: 'GH-282', tasksDir: '/tmp/x' });
  assert.match(text, /\*\*Status:\*\* APPROVED/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectFabrication } = require('../fabrication-detector');

test('integration: real temp taskDir with tests.check.md sources a PASS row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabdet-int-'));
  fs.writeFileSync(
    path.join(dir, 'tests.check.md'),
    '# checks\n- modal opens on click: verified locally\n',
    'utf8'
  );
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status | Notes |',
    '| --- | --- | --- |',
    '| modal opens on click | PASS | covered by E2E |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  assert.equal(violations.length, 0);
});

test('integration: real temp taskDir without artifacts flags an unsourced PASS row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabdet-int-'));
  const prBody = [
    '## Test Results',
    '',
    '| Test | Status | Notes |',
    '| --- | --- | --- |',
    '| user can log in | PASS | smoke verified |',
    '',
  ].join('\n');
  const { violations } = detectFabrication(prBody, dir);
  assert.ok(violations.some((v) => v.reason === 'unsourced-test-row'));
});

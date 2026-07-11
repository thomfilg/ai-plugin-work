/**
 * write-phase-context.test.js — shared phase-context snapshot writer used by
 * the work-task-review diff_audit and work-reports collect_artifacts phases
 * (extracted to remove their duplicated writeContext boilerplate, GH-693).
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writePhaseContext } = require('../write-phase-context');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'write-phase-context-'));

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

describe('writePhaseContext', () => {
  it('writes extra fields plus fileCount/files/capturedAt to the named file', () => {
    const dir = path.join(TEMP, 'ok');
    fs.mkdirSync(dir, { recursive: true });
    writePhaseContext(dir, 'task-review-context.json', ['a.js', 'b.js'], {
      ticket: 'GH-1',
      base: 'abc',
      head: 'HEAD',
      fallback: false,
    });
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'task-review-context.json'), 'utf8'));
    assert.equal(parsed.ticket, 'GH-1');
    assert.equal(parsed.base, 'abc');
    assert.equal(parsed.head, 'HEAD');
    assert.equal(parsed.fallback, false);
    assert.equal(parsed.fileCount, 2);
    assert.deepEqual(parsed.files, ['a.js', 'b.js']);
    assert.ok(!Number.isNaN(Date.parse(parsed.capturedAt)), 'capturedAt must be a timestamp');
  });

  it('works without extra fields', () => {
    const dir = path.join(TEMP, 'noextra');
    fs.mkdirSync(dir, { recursive: true });
    writePhaseContext(dir, 'reports-context.json', []);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'reports-context.json'), 'utf8'));
    assert.equal(parsed.fileCount, 0);
    assert.deepEqual(parsed.files, []);
  });

  it('swallows write errors (hook-gated snapshot is non-fatal)', () => {
    const missing = path.join(TEMP, 'does', 'not', 'exist');
    assert.doesNotThrow(() =>
      writePhaseContext(missing, 'reports-context.json', ['x'], { ticket: 'GH-2' })
    );
    assert.equal(fs.existsSync(path.join(missing, 'reports-context.json')), false);
  });
});

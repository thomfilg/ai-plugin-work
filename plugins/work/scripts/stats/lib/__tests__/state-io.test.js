/**
 * Tests for the shared `.work-state.json` reader (GH-317 / R10).
 *
 * Scenarios covered:
 *   - falsy path → { ok:false, reason:'missing' }
 *   - non-existent path → { ok:false, reason:'missing' }
 *   - valid JSON → { ok:true, state }
 *   - corrupt JSON → { ok:false, reason:'corrupt' }
 *
 * Run with:
 *   node --test scripts/stats/lib/__tests__/state-io.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readStateFile } = require('../state-io');

describe('state-io — readStateFile (R10)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-io-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports readStateFile as a named function', () => {
    assert.equal(typeof readStateFile, 'function');
  });

  it('returns { ok:false, reason:"missing" } for a falsy path', () => {
    assert.deepEqual(readStateFile(null), { ok: false, reason: 'missing' });
    assert.deepEqual(readStateFile(''), { ok: false, reason: 'missing' });
    assert.deepEqual(readStateFile(undefined), { ok: false, reason: 'missing' });
  });

  it('returns { ok:false, reason:"missing" } when the file does not exist', () => {
    const missing = path.join(tmpDir, 'nope', '.work-state.json');
    assert.deepEqual(readStateFile(missing), { ok: false, reason: 'missing' });
  });

  it('returns { ok:true, state } for valid JSON', () => {
    const file = path.join(tmpDir, 'valid.json');
    const state = { ticketId: 'GH-1', currentStep: 3 };
    fs.writeFileSync(file, JSON.stringify(state));
    const read = readStateFile(file);
    assert.equal(read.ok, true);
    assert.deepEqual(read.state, state);
  });

  it('returns { ok:false, reason:"corrupt" } for invalid JSON', () => {
    const file = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(readStateFile(file), { ok: false, reason: 'corrupt' });
  });
});

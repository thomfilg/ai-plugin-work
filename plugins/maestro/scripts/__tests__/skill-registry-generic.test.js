// skill-registry.js — oracle-gated generic command support (GH-514 decision).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MOD = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'skill-registry.js');

function freshReg(tasksBase) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('skill-registry')) delete require.cache[k];
  }
  process.env.TASKS_BASE = tasksBase;
  return require(MOD);
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-skillreg-'));
}

test('whitelisted skills allowed regardless of oracle', () => {
  const reg = freshReg(tmp());
  assert.equal(reg.isAllowedSkill('work'), true);
  assert.equal(reg.isAllowedSkill('follow-up'), true);
  assert.equal(reg.isKnownSkill('qc-work'), false);
});

test('non-whitelisted command rejected without oracle, allowed with', () => {
  const reg = freshReg(tmp());
  assert.equal(reg.isAllowedSkill('qc-work'), false);
  assert.equal(reg.isAllowedSkill('qc-work', { hasOracle: true }), true);
  // still must be regex-valid even with an oracle
  assert.equal(reg.isAllowedSkill('Bad Name', { hasOracle: true }), false);
});

test('get() returns a generic row for oracle-backed unknown commands', () => {
  const reg = freshReg(tmp());
  assert.equal(reg.get('qc-work'), undefined);
  const row = reg.get('qc-work', { hasOracle: true });
  assert.ok(row);
  assert.equal(row.generic, true);
  assert.equal(row.snapshot('GH-1'), null);
  assert.equal(row.isHealthyIdle({ status: 'complete' }), false);
});

test('writeTicketSkill: rejects unknown without oracle, persists with', () => {
  const base = tmp();
  const reg = freshReg(base);
  assert.throws(() => reg.writeTicketSkill('GH-1', 'qc-work'), /without a stop-condition oracle/);

  reg.writeTicketSkill('GH-1', 'qc-work', { hasOracle: true });
  // round-trips only when the reader is also told the ticket is oracle-backed
  assert.equal(reg.readTicketSkill('GH-1', { hasOracle: true }), 'qc-work');
  // without the oracle hint the reader falls open to /work (GH-514 typo guard)
  assert.equal(reg.readTicketSkill('GH-1'), 'work');
});

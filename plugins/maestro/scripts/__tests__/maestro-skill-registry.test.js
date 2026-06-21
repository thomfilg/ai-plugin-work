// Task 1 — skill-registry module (GH-514).
//
// Validates the new `lib/maestro-conduct/skill-registry.js` seam:
//   - `work` and `follow-up` rows with `{stateFile, snapshot, isHealthyIdle, silenceLimitSec}`
//   - `readTicketSkill(ticket)` falls open to `'work'` (missing file, unknown stored value, invalid)
//   - `writeTicketSkill(ticket, name)` rejects names that don't match the whitelist regex
//   - `follow-up` row maps `status ∈ {awaiting_ci, awaiting_user, complete}` → `phase: 'complete'`
//   - `work` row's `snapshot` is the literal `workstate.snapshot` export (single source).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REGISTRY_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'skill-registry.js');
const WORKSTATE_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'workstate.js');

function freshRegistry(tasksBase) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  process.env.TASKS_BASE = tasksBase;
  return require(REGISTRY_LIB);
}

function mkTasksBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-tasks-'));
}

function writeTicketFile(tasksBase, ticket, basename, contents) {
  const dir = path.join(tasksBase, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, basename), contents);
}

test('isKnownSkill: whitelist accepts work and follow-up, rejects anything else', () => {
  const tasksBase = mkTasksBase();
  const reg = freshRegistry(tasksBase);
  assert.equal(reg.isKnownSkill('work'), true);
  assert.equal(reg.isKnownSkill('follow-up'), true);
  assert.equal(reg.isKnownSkill('evil; rm -rf /'), false);
  assert.equal(reg.isKnownSkill('UPPER'), false);
  assert.equal(reg.isKnownSkill(''), false);
  assert.equal(reg.isKnownSkill(null), false);
});

test('readTicketSkill: missing .maestro-skill file falls open to "work"', () => {
  const tasksBase = mkTasksBase();
  const reg = freshRegistry(tasksBase);
  // No file written at all.
  assert.equal(reg.readTicketSkill('GH-9001'), 'work');
});

test('readTicketSkill: unknown stored value falls open to "work"', () => {
  const tasksBase = mkTasksBase();
  writeTicketFile(tasksBase, 'GH-9002', '.maestro-skill', 'totally-unknown-skill\n');
  const reg = freshRegistry(tasksBase);
  assert.equal(reg.readTicketSkill('GH-9002'), 'work');
});

test('readTicketSkill: whitelisted value is returned verbatim (trimmed)', () => {
  const tasksBase = mkTasksBase();
  writeTicketFile(tasksBase, 'GH-9003', '.maestro-skill', '  follow-up  \n');
  const reg = freshRegistry(tasksBase);
  assert.equal(reg.readTicketSkill('GH-9003'), 'follow-up');
});

test('writeTicketSkill: rejects names that fail the whitelist regex', () => {
  const tasksBase = mkTasksBase();
  const reg = freshRegistry(tasksBase);
  assert.throws(() => reg.writeTicketSkill('GH-9004', 'evil; rm -rf /'));
  assert.throws(() => reg.writeTicketSkill('GH-9004', 'UPPER'));
  assert.throws(() => reg.writeTicketSkill('GH-9004', ''));
});

test('writeTicketSkill: rejects regex-valid but registry-unknown names (PR #561 review)', () => {
  // 'followup' is a typo for 'follow-up' — passes the regex but isn't in the
  // registry. Persisting it would let bootstrap launch /followup while the
  // conductor falls open to /work (split state).
  const tasksBase = mkTasksBase();
  const reg = freshRegistry(tasksBase);
  assert.throws(
    () => reg.writeTicketSkill('GH-9006', 'followup'),
    /registry-unknown skill/,
    'unknown skill must be rejected with a registry-unknown error'
  );
  assert.throws(
    () => reg.writeTicketSkill('GH-9006', 'check'),
    /registry-unknown skill/,
    'arbitrary unregistered names must also be rejected'
  );
  // .maestro-skill must NOT have been written.
  const p = path.join(tasksBase, 'GH-9006', '.maestro-skill');
  assert.equal(fs.existsSync(p), false, '.maestro-skill must NOT be created for rejected writes');
});

test('writeTicketSkill: persists a valid skill name as single-line file', () => {
  const tasksBase = mkTasksBase();
  const reg = freshRegistry(tasksBase);
  reg.writeTicketSkill('GH-9005', 'follow-up');
  const p = path.join(tasksBase, 'GH-9005', '.maestro-skill');
  assert.equal(fs.readFileSync(p, 'utf8').trim(), 'follow-up');
  // Round-trip via the reader.
  assert.equal(reg.readTicketSkill('GH-9005'), 'follow-up');
});

test('get("work"): row delegates snapshot to workstate.snapshot (single source)', () => {
  const tasksBase = mkTasksBase();
  const reg = freshRegistry(tasksBase);
  const workstate = require(WORKSTATE_LIB);
  const row = reg.get('work');
  assert.ok(row, 'work row must exist');
  assert.equal(row.silenceLimitSec, 300);
  assert.equal(row.snapshot, workstate.snapshot);
});

test('get("follow-up"): maps status=awaiting_ci to phase=complete', () => {
  const tasksBase = mkTasksBase();
  writeTicketFile(
    tasksBase,
    'GH-9100',
    '.follow-up-state.json',
    JSON.stringify({ status: 'awaiting_ci', step: 'wait_ci' })
  );
  const reg = freshRegistry(tasksBase);
  const row = reg.get('follow-up');
  assert.ok(row, 'follow-up row must exist');
  assert.equal(row.silenceLimitSec, 1800);
  const snap = row.snapshot('GH-9100');
  assert.equal(snap.phase, 'complete');
  assert.equal(snap.step, 'wait_ci');
});

test('get("follow-up"): maps status=awaiting_user and status=complete to phase=complete', () => {
  for (const status of ['awaiting_user', 'complete']) {
    const tasksBase = mkTasksBase();
    writeTicketFile(
      tasksBase,
      'GH-9101',
      '.follow-up-state.json',
      JSON.stringify({ status, step: 's1' })
    );
    const reg = freshRegistry(tasksBase);
    const snap = reg.get('follow-up').snapshot('GH-9101');
    assert.equal(snap.phase, 'complete', `status=${status} should map to phase=complete`);
  }
});

test('get("follow-up"): non-healthy status maps to phase=follow_up', () => {
  const tasksBase = mkTasksBase();
  writeTicketFile(
    tasksBase,
    'GH-9102',
    '.follow-up-state.json',
    JSON.stringify({ status: 'running', step: 'apply_review' })
  );
  const reg = freshRegistry(tasksBase);
  const snap = reg.get('follow-up').snapshot('GH-9102');
  assert.equal(snap.phase, 'follow_up');
  assert.equal(snap.step, 'apply_review');
});

test('get("follow-up"): missing .follow-up-state.json returns null (null-safe)', () => {
  const tasksBase = mkTasksBase();
  const reg = freshRegistry(tasksBase);
  assert.equal(reg.get('follow-up').snapshot('GH-9103'), null);
});

test('get("follow-up"): isHealthyIdle returns true for healthy idle states', () => {
  const tasksBase = mkTasksBase();
  const reg = freshRegistry(tasksBase);
  const row = reg.get('follow-up');
  assert.equal(row.isHealthyIdle({ status: 'awaiting_ci' }), true);
  assert.equal(row.isHealthyIdle({ status: 'awaiting_user' }), true);
  assert.equal(row.isHealthyIdle({ status: 'complete' }), true);
  assert.equal(row.isHealthyIdle({ status: 'running' }), false);
  assert.equal(row.isHealthyIdle(null), false);
});

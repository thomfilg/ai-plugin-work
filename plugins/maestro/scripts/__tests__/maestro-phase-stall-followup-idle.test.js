// Task 3 — ctxFor skill-aware snapshot + phase-stall healthy-idle suppression (GH-514).
//
// RED scenarios:
//   (a) Given .maestro-skill=follow-up + .follow-up-state.json{status:awaiting_ci},
//       ctxFor(session) returns ctx.skill==='follow-up' and ctx.phase==='complete'.
//   (b) phase-stall detector returns no hit for that ctx (healthy idle).
//   (c) Absent .maestro-skill → ctx.skill==='work', behavior unchanged (smoke).
//
// Covers: R2, R5, AC3, spec §Architecture.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONDUCT_PATH = path.resolve(__dirname, '..', 'maestro-conduct.js');
const PHASE_STALL_PATH = path.resolve(
  __dirname,
  '..',
  'lib',
  'maestro-conduct',
  'detectors',
  'phase-stall.js'
);
const TMUX_PATH = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'tmux.js');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTicketFile(tasksBase, ticket, basename, contents) {
  const dir = path.join(tasksBase, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, basename), contents);
}

function freshConduct({ tasksBase, stateDir, session, ticket }) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct') || k.endsWith('/maestro-conduct.js')) {
      delete require.cache[k];
    }
  }
  process.env.TASKS_BASE = tasksBase;
  process.env.WORKTREES_BASE = tasksBase; // harmless, points worktree dir at same temp area
  process.env.STATE_DIR = stateDir;
  // Stub tmux module so ctxFor() doesn't shell out.
  const tmux = require(TMUX_PATH);
  tmux.ticketIdFor = () => ticket;
  tmux.capture = () => '';
  return require(CONDUCT_PATH);
}

test('ctxFor: follow-up ticket with awaiting_ci yields ctx.skill=follow-up and ctx.phase=complete', () => {
  const tasksBase = mkTmpDir('phase-stall-followup-');
  const stateDir = mkTmpDir('phase-stall-state-');
  const ticket = 'GH-9300';
  writeTicketFile(tasksBase, ticket, '.maestro-skill', 'follow-up\n');
  writeTicketFile(
    tasksBase,
    ticket,
    '.follow-up-state.json',
    JSON.stringify({ status: 'awaiting_ci', step: 'wait_ci' })
  );
  const conduct = freshConduct({ tasksBase, stateDir, session: `${ticket}-work`, ticket });
  const ctx = conduct.ctxFor(`${ticket}-work`);
  assert.equal(ctx.skill, 'follow-up', 'ctx.skill must be follow-up');
  assert.equal(ctx.phase, 'complete', 'follow-up awaiting_ci must map to phase=complete');
  assert.equal(ctx.ticket, ticket);
});

test('Healthy idle /follow-up agent is NOT flagged as phase-stall', () => {
  const tasksBase = mkTmpDir('phase-stall-followup-');
  const stateDir = mkTmpDir('phase-stall-state-');
  const ticket = 'GH-9301';
  writeTicketFile(tasksBase, ticket, '.maestro-skill', 'follow-up\n');
  writeTicketFile(
    tasksBase,
    ticket,
    '.follow-up-state.json',
    JSON.stringify({ status: 'awaiting_ci', step: 'wait_ci' })
  );
  const conduct = freshConduct({ tasksBase, stateDir, session: `${ticket}-work`, ticket });
  const phaseStall = require(PHASE_STALL_PATH);
  const ctx = conduct.ctxFor(`${ticket}-work`);
  // First call seeds the marker; should not be a hit.
  const r1 = phaseStall.detect(ctx);
  assert.equal(r1.hit, false, 'first phase-stall detect on follow-up idle must be no-hit');
  // Second call, even after time has elapsed conceptually, must still be no-hit
  // because phase=complete is a healthy-idle terminal phase — never escalating.
  const r2 = phaseStall.detect(ctx);
  assert.equal(r2.hit, false, 'subsequent phase-stall detect on follow-up idle must remain no-hit');
});

test('ctxFor: absent .maestro-skill defaults ctx.skill to "work" (smoke)', () => {
  const tasksBase = mkTmpDir('phase-stall-work-');
  const stateDir = mkTmpDir('phase-stall-state-');
  const ticket = 'GH-9302';
  // Intentionally no .maestro-skill file; no .work-state.json either, so phase=null.
  const conduct = freshConduct({ tasksBase, stateDir, session: `${ticket}-work`, ticket });
  const ctx = conduct.ctxFor(`${ticket}-work`);
  assert.equal(ctx.skill, 'work', 'absent .maestro-skill must default ctx.skill=work');
});

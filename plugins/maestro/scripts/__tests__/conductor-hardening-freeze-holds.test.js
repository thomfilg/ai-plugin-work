'use strict';

/**
 * Pins for the 2026-07-12 conductor hardening (fleet post-mortem fixes):
 *   1. usage-limit freeze detection — banner recognized, 95% warning ignored
 *   2. progress: pane token counter counts as progress (worktree-quiet phases)
 *   3. ci-gate rotation HOLDS on dirty worktree / CHANGES_REQUESTED verdict
 *   4. parked-oracle sweep evaluates awaiting-merge tickets w/o live sessions
 *   5. auto-bootstrap holds while a usage freeze was sighted recently
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate every store BEFORE requiring the modules (they resolve at require).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-hardening-'));
process.env.STATE_DIR = path.join(TMP, 'state');
process.env.WORKTREES_BASE = path.join(TMP, 'wt');
process.env.TASKS_BASE = path.join(TMP, 'tasks');
fs.mkdirSync(process.env.WORKTREES_BASE, { recursive: true });
fs.mkdirSync(process.env.TASKS_BASE, { recursive: true });

const usageLimit = require('../lib/maestro-conduct/usage-limit');
const progress = require('../lib/maestro-conduct/progress');
const ciGate = require('../lib/maestro-conduct/ci-gate-rotation');
const stopCondition = require('../lib/maestro-conduct/stop-condition');
const state = require('../lib/maestro-conduct/state');

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: TMP };
  execFileSync('git', ['-C', dir, 'init', '-q'], { env });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { env });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { env });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', dir, 'add', '.'], { env });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init'], { env });
  return dir;
}

test('usage-limit: freeze banner detected, percent warning is NOT a freeze', () => {
  assert.equal(
    usageLimit.isUsageLimitFrozen(
      "some output\nYou've hit your session limit · resets 4:20pm (America/Sao_Paulo)\n"
    ),
    true
  );
  assert.equal(usageLimit.isUsageLimitFrozen('You’ve hit your session limit'), true);
  assert.equal(
    usageLimit.isUsageLimitFrozen("You've used 95% of your session limit · resets 4:20pm"),
    false
  );
  assert.equal(usageLimit.isUsageLimitFrozen(''), false);
  assert.equal(usageLimit.isUsageLimitFrozen(null), false);
});

test('progress.paneTokenFigure: picks the largest token figure, k-suffix aware', () => {
  const pane = '✻ Pondering… (21m · ↓ 60.4k tokens)\n  bypass on · 1 monitor  364921 tokens\n';
  assert.equal(progress.paneTokenFigure(pane), 364921);
  assert.equal(progress.paneTokenFigure('spinner ↓ 6.9k tokens'), 6900);
  assert.equal(progress.paneTokenFigure('no counters here'), null);
  assert.equal(progress.paneTokenFigure(null), null);
});

test('progress.observe: token movement alone counts as progress', () => {
  const wt = gitInit(path.join(TMP, 'wt-tokens'));
  const t = 'GH-9001';
  const first = progress.observe(t, wt, 'x 1000 tokens');
  assert.equal(first.changed, true); // first sighting
  const same = progress.observe(t, wt, 'x 1000 tokens');
  assert.equal(same.changed, false); // nothing moved
  const grown = progress.observe(t, wt, 'x 2000 tokens');
  assert.equal(grown.changed, true); // tokens moved, worktree untouched
});

test('ci-gate rotationHold: dirty worktree blocks, clean allows', () => {
  const wt = gitInit(path.join(TMP, 'wt-rot'));
  assert.equal(ciGate.rotationHold({ ticket: 'GH-9002', worktree: wt }), null);
  fs.writeFileSync(path.join(wt, 'uncommitted.js'), 'x\n');
  assert.equal(ciGate.rotationHold({ ticket: 'GH-9002', worktree: wt }), 'dirty-worktree');
});

test('ci-gate rotationHold: CHANGES_REQUESTED verdict blocks, APPROVED allows', () => {
  const wt = gitInit(path.join(TMP, 'wt-verdict'));
  const t = 'GH-9003';
  const dir = path.join(process.env.TASKS_BASE, t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${t}-pr-review.md`), 'findings…\nVERDICT: CHANGES_REQUESTED\n');
  assert.equal(ciGate.rotationHold({ ticket: t, worktree: wt }), 'changes-requested-verdict');
  fs.writeFileSync(path.join(dir, `${t}-pr-review.md`), 'clean\nVERDICT: APPROVED\n');
  assert.equal(ciGate.rotationHold({ ticket: t, worktree: wt }), null);
});

test('sweepParkedOracles: evaluates parked tickets, skips live sessions, honors gate', () => {
  const freed = [];
  const actions = { freeStopConditionSlot: (a) => (freed.push(a.ticket), true) };
  const tmuxMod = { sessionName: (t, kind) => `${t}-${kind}` };
  const manifest = {
    tasksByStatus: () => [{ taskId: 'GH-9010' }, { taskId: 'GH-9011' }, { taskId: 'GH-9012' }],
    stopOracleForTask: (t) => (t === 'GH-9012' ? null : t === 'GH-9010' ? 'exit 0' : 'exit 1'),
  };
  const n = stopCondition.sweepParkedOracles({
    manifest,
    actions,
    tmuxMod,
    liveSessions: [],
  });
  assert.equal(n, 1); // only GH-9010's oracle passed; 9011 fails; 9012 has none
  assert.deepEqual(freed, ['GH-9010']);

  // A live -work session owns its own oracle path — the sweep must skip it.
  freed.length = 0;
  const n2 = stopCondition.sweepParkedOracles({
    manifest,
    actions,
    tmuxMod,
    liveSessions: ['GH-9010-work'],
  });
  assert.equal(n2, 0);
  assert.deepEqual(freed, []);

  // Feature gate off → no evaluation at all.
  process.env.AUTO_FREE_STOP_CONDITION = '0';
  try {
    assert.equal(
      stopCondition.sweepParkedOracles({ manifest, actions, tmuxMod, liveSessions: [] }),
      0
    );
  } finally {
    delete process.env.AUTO_FREE_STOP_CONDITION;
  }
});

test('usage-freeze hold: fresh sighting blocks auto-bootstrap window', () => {
  const actions = require('../lib/maestro-conduct/actions');
  assert.equal(actions.usageFreezeActive(), false);
  actions.noteUsageFreeze();
  assert.equal(actions.usageFreezeActive(), true);
  // Age the marker past the hold window → gate re-opens.
  state.write('_global', 'usage-limit-freeze', { lastSeenAt: state.now() - 3600 });
  assert.equal(actions.usageFreezeActive(), false);
});

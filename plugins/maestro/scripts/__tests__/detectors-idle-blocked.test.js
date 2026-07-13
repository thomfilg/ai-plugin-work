// detectors/idle-blocked.js — pattern-NEGATIVE backstop for the question
// detection gap (GH-698 A1): an idle empty composer with no spinner and no
// tool subprocess for N consecutive ticks is blocked on SOMETHING, whether or
// not the question regexes recognize it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const MOD = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'detectors', 'idle-blocked.js');
const STATE = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state.js');
const PANE_BUSY = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'pane-busy.js');

function fresh(stateDir, opts = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  const pbPath = require.resolve(PANE_BUSY);
  require.cache[pbPath] = {
    id: pbPath,
    filename: pbPath,
    loaded: true,
    exports: { paneHasLiveSubprocess: () => !!opts.busy, panePid: () => null },
  };
  return { det: require(MOD), state: require(STATE) };
}

const IDLE_PANE = ['● Done with the last task.', '', '❯ ', ''].join('\n');

test('detect: idle empty composer hits only after Q_IDLE_CONFIRM_TICKS consecutive ticks', () => {
  const { det } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'idleb-')));
  const ctx = { session: 'GH-1-work', pane: IDLE_PANE };
  assert.equal(det.Q_IDLE_CONFIRM_TICKS, 3, 'default confirmation window is 3 ticks');
  assert.equal(det.detect(ctx).hit, false, 'tick 1 arms the marker');
  assert.equal(det.detect(ctx).hit, false, 'tick 2 still confirming');
  const hit = det.detect(ctx);
  assert.equal(hit.hit, true, 'tick 3 confirms idle-blocked');
  assert.equal(hit.kind, 'idle-blocked');
  assert.equal(hit.ticks, 3);
  assert.equal(typeof hit.elapsedMin, 'number');
});

test('detect: any busy/owned signature re-arms the counter and reports cleared once', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idleb-'));
  const { det, state } = fresh(stateDir);

  const spinnerPane = '✻ Cooking… (3m 12s · ↓ 2.1k tokens)\n❯ ';
  const queuedPane = '● idle\n❯ Go with option B\n';
  const menuPane = '❯ 1. Yes, proceed\n  2. No\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  const noComposerPane = 'make: waiting for lock\n$ ';

  for (const [pane, why] of [
    [spinnerPane, 'live spinner'],
    [queuedPane, 'queued composer text (stuck-input territory)'],
    [menuPane, 'recognized question prompt (question territory)'],
    [noComposerPane, 'no composer at all (silence territory)'],
  ]) {
    state.write('GH-2-work', 'idle-blocked', { ticks: 2, firstSeenAt: state.now() - 600 });
    const first = det.detect({ session: 'GH-2-work', pane });
    assert.equal(first.hit, false, `${why}: never a hit`);
    assert.equal(first.cleared, true, `${why}: clearing tick reports cleared`);
    assert.equal(state.read('GH-2-work', 'idle-blocked'), null, `${why}: marker dropped`);
    const second = det.detect({ session: 'GH-2-work', pane });
    assert.equal(second.cleared, undefined, `${why}: no marker → no repeat resolution`);
  }
});

test('detect: a live tool subprocess means working-quietly, never idle-blocked (GH-698)', () => {
  const { det, state } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'idleb-')), { busy: true });
  state.write('GH-3-work', 'idle-blocked', { ticks: 5, firstSeenAt: state.now() - 3600 });
  const r = det.detect({ session: 'GH-3-work', pane: IDLE_PANE });
  assert.equal(r.hit, false, 'busy pane is not idle-blocked even with an armed marker');
  assert.equal(r.cleared, true, 'busy tick retires the armed marker');
});

test('detect: the LAST cursor line decides — a historical bare ❯ above queued text is not idle', () => {
  const { det } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'idleb-')));
  const pane = '❯ \nsome scrollback\n❯ queued directive\n';
  assert.equal(det.lastCursorLine(pane).trim(), '❯ queued directive');
  assert.equal(det.detect({ session: 'GH-4-work', pane }).hit, false);
});

test('detect: codex dialects report unsupported; missing session/pane is a no-op', () => {
  const { det } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'idleb-')));
  const codex = det.detect({ session: 'GH-5-work', pane: IDLE_PANE, dialect: 'codex-exec-json' });
  assert.equal(codex.hit, false);
  assert.equal(codex.capability, 'unsupported');
  assert.equal(det.detect({ session: null, pane: IDLE_PANE }).hit, false);
  assert.equal(det.detect({ session: 'GH-5-work', pane: '' }).hit, false);
});

test('detect: elapsedMin measures from the FIRST idle tick, not the confirming one', () => {
  const { det, state } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'idleb-')));
  state.write('GH-6-work', 'idle-blocked', { ticks: 44, firstSeenAt: state.now() - 44 * 60 });
  const hit = det.detect({ session: 'GH-6-work', pane: IDLE_PANE });
  assert.equal(hit.hit, true);
  assert.equal(hit.ticks, 45);
  assert.ok(hit.elapsedMin >= 44, 'the 44-minute class of undetected prompt is now measured');
});

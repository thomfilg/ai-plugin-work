// detectors/stuck-input.js — queued-but-never-submitted composer text
// (GH-449 mode 6). Directives have sat unsubmitted in agent composers for
// hours; this detector surfaces them.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const MOD = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'detectors', 'stuck-input.js');
const STATE = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state.js');

function fresh(stateDir) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  return { det: require(MOD), state: require(STATE) };
}

const IDLE_PANE_WITH_TEXT = ['● Done with the last task.', '', '❯ Go with option B', ''].join('\n');

test('composerText: extracts queued text; ignores menu cursors', () => {
  const { det } = fresh(fs.mkdtempSync(path.join(os.tmpdir(), 'stuckin-')));
  assert.equal(det.composerText(IDLE_PANE_WITH_TEXT), 'Go with option B');
  assert.equal(det.composerText('❯ 1. Yes, proceed\n  2. No'), null, 'menu cursor is not composer');
  assert.equal(det.composerText('some output\n❯ \n'), null, 'empty composer is not stuck text');
});

test('detect: hits only after the SAME text persists past STUCK_INPUT_MIN', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuckin-'));
  const { det, state } = fresh(stateDir);
  const ctx = { session: 'GH-1-work', pane: IDLE_PANE_WITH_TEXT };

  // First sighting arms the marker, no hit.
  assert.equal(det.detect(ctx).hit, false);
  // Backdate the marker to simulate persistence past the threshold.
  state.write('GH-1-work', 'stuck-input', {
    text: 'Go with option B',
    firstSeenAt: state.now() - 10 * 60,
  });
  const hit = det.detect(ctx);
  assert.equal(hit.hit, true);
  assert.equal(hit.kind, 'stuck-input');
  assert.equal(hit.text, 'Go with option B');
  assert.ok(hit.elapsedMin >= 10);
});

test('detect: text change re-arms; live spinner and cleared composer do not hit', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuckin-'));
  const { det, state } = fresh(stateDir);

  // Different text than the marker → re-arm, no hit.
  state.write('GH-2-work', 'stuck-input', { text: 'old text', firstSeenAt: state.now() - 60 * 60 });
  assert.equal(det.detect({ session: 'GH-2-work', pane: IDLE_PANE_WITH_TEXT }).hit, false);

  // Live spinner → agent is mid-turn; queued text is EXPECTED. Never a hit.
  const spinnerPane = `✻ Cooking… (3m 12s · ↓ 2.1k tokens)\n❯ queued directive`;
  state.write('GH-3-work', 'stuck-input', {
    text: 'queued directive',
    firstSeenAt: state.now() - 60 * 60,
  });
  assert.equal(det.detect({ session: 'GH-3-work', pane: spinnerPane }).hit, false);

  // Composer cleared → marker cleared.
  state.write('GH-4-work', 'stuck-input', { text: 'gone', firstSeenAt: state.now() - 60 * 60 });
  assert.equal(det.detect({ session: 'GH-4-work', pane: '● idle\n❯ \n' }).hit, false);
  assert.equal(state.read('GH-4-work', 'stuck-input'), null);
});

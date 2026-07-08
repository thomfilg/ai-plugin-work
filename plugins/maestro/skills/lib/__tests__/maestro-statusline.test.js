/**
 * Unit tests for the maestro fleet status-line renderer's pure logic:
 *   - resolveTicketIcon: marker/status -> single status glyph, severity order,
 *     freshness gating, nudge escalation.
 *   - formatSegment: per-ticket glyph placement + the done/total✓ ⏳ envelope.
 *
 * Pure functions only — no tmux, no live conductor. Run with:
 *   node --test maestro-statusline.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ICON,
  NUDGE_WINDOW_SEC,
  SILENCE_LIMIT_SEC,
  OVERLAY_FRESH_SEC,
  resolveTicketIcon,
  formatSegment,
} = require('../maestro-statusline.js');

const NOW = 1_800_000_000; // fixed clock (seconds)

describe('resolveTicketIcon — severity + freshness', () => {
  it('working when the silence heartbeat is fresh', () => {
    const m = { silence: { lastActiveAt: NOW - 10, tokens: 100 } };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.working);
  });

  it('stalled when the heartbeat is older than the silence limit', () => {
    const m = { silence: { lastActiveAt: NOW - (SILENCE_LIMIT_SEC + 5) } };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.stalled);
  });

  it('question outranks a fresh working heartbeat', () => {
    const m = {
      question: { startedAt: NOW - 30, lastAlertAt: NOW - 5 },
      silence: { lastActiveAt: NOW - 5 },
    };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.question);
  });

  it('a stale question marker does NOT render (freshness gate)', () => {
    const m = {
      question: { startedAt: NOW - 99999, lastAlertAt: NOW - (OVERLAY_FRESH_SEC + 60) },
      silence: { lastActiveAt: NOW - 5 },
    };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.working);
  });

  it('nudge escalation: 1 -> ⚠, 2 -> ⚠⚠, 3+ -> 💀', () => {
    const one = { restartLoop: { restarts: [NOW - 60] } };
    const two = { restartLoop: { restarts: [NOW - 120, NOW - 60] } };
    const three = { restartLoop: { restarts: [NOW - 180, NOW - 120, NOW - 60] } };
    assert.equal(resolveTicketIcon(one, 'in_progress', NOW), ICON.nudge1);
    assert.equal(resolveTicketIcon(two, 'in_progress', NOW), ICON.nudge2);
    assert.equal(resolveTicketIcon(three, 'in_progress', NOW), ICON.wedged);
  });

  it('nudges outside the restart window are ignored', () => {
    const m = {
      restartLoop: { restarts: [NOW - (NUDGE_WINDOW_SEC + 100)] },
      silence: { lastActiveAt: NOW - 5 },
    };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.working);
  });

  it('dead-end killed -> 💀', () => {
    const m = { deadEnd: { killed: true, freedAt: NOW - 60, trigger: 'question-pending' } };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.wedged);
  });

  it('pr-broken outranks nudges and working', () => {
    const m = {
      prStatus: { lastState: 'pr-broken', lastEmittedAt: NOW - 4000 },
      restartLoop: { restarts: [NOW - 60] },
      silence: { lastActiveAt: NOW - 5 },
    };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.prBroken);
  });

  it('pr-ready shows ✅ when otherwise idle', () => {
    const m = { prStatus: { lastState: 'pr-ready', lastEmittedAt: NOW - 100 } };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.prReady);
  });

  it('stuck-input -> ✎', () => {
    const m = { stuckInput: { text: 'ping me', firstSeenAt: NOW - 30 } };
    assert.equal(resolveTicketIcon(m, 'in_progress', NOW), ICON.stuck);
  });

  it('status fallbacks: awaiting-merge / stopped / done', () => {
    assert.equal(resolveTicketIcon({}, 'awaiting-merge', NOW), ICON.prReady);
    assert.equal(resolveTicketIcon({}, 'stopped', NOW), ICON.stopped);
    assert.equal(resolveTicketIcon({}, 'blocked', NOW), ICON.stopped);
    assert.equal(resolveTicketIcon({}, 'done', NOW), ICON.done);
  });

  it('no markers, in-progress -> working default', () => {
    assert.equal(resolveTicketIcon({}, 'in_progress', NOW), ICON.working);
    assert.equal(resolveTicketIcon(null, undefined, NOW), ICON.working);
  });
});

describe('formatSegment — glyph placement + counts envelope', () => {
  const icons = { 'ECHO-6305': ICON.question, 'ECHO-6306': ICON.working };
  const iconFor = (id) => icons[id] || '';

  it('prefixes each id with its glyph and keeps the done/total ⏳ envelope', () => {
    const line = formatSegment(
      'ECHO',
      ['ECHO-6305', 'ECHO-6306'],
      { done: 2, total: 8, pending: 4 },
      iconFor
    );
    assert.equal(
      line,
      `🎼 ECHO   2/8✓  ▶2 (${ICON.question} ECHO-6305, ${ICON.working} ECHO-6306)  ⏳4`
    );
  });

  it('falls back to the count-less format when no manifest matches', () => {
    const line = formatSegment('ECHO', ['ECHO-6305'], null, iconFor);
    assert.equal(line, `🎼 ECHO   ▶  1  (${ICON.question} ECHO-6305)`);
  });

  it('renders a bare id when no glyph resolves', () => {
    const line = formatSegment('ECHO', ['ECHO-9999'], { done: 0, total: 1, pending: 0 }, () => '');
    assert.equal(line, '🎼 ECHO   0/1✓  ▶1 (ECHO-9999)  ⏳0');
  });
});

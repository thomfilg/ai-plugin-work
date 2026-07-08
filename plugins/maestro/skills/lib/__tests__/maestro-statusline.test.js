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
  HEAT_MIN_MIN,
  ANSI_RESET,
  resolveTicketIcon,
  heatAnsi,
  formatElapsed,
  elapsedBadge,
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

describe('runtime heat — per-band shade walk', () => {
  it('below the heat floor: no color, bare label', () => {
    assert.equal(heatAnsi(0, true), '');
    assert.equal(heatAnsi(HEAT_MIN_MIN - 1, true), '');
    assert.equal(elapsedBadge(12, true), '12m');
  });

  it('truecolor walks SHADES within a band, then jumps hue at the boundary', () => {
    // Yellow band start (30m) = light yellow (255,255,180).
    assert.equal(heatAnsi(30, true), '\x1b[38;2;255;255;180m');
    // Just before the orange boundary the yellow has deepened (G/B dropped).
    const yellowLate = heatAnsi(44, true);
    assert.match(yellowLate, /^\x1b\[38;2;255;\d+;\d+m$/);
    assert.notEqual(yellowLate, heatAnsi(30, true));
    // 45m enters the orange band at its LIGHT shade — a hue jump, not a continuation.
    assert.equal(heatAnsi(45, true), '\x1b[38;2;255;200;120m');
    // 60m enters the red band at its light shade.
    assert.equal(heatAnsi(60, true), '\x1b[38;2;255;90;90m');
  });

  it('past the last band pins to the deepest red', () => {
    assert.equal(heatAnsi(90, true), '\x1b[38;2;170;0;0m');
    assert.equal(heatAnsi(999, true), '\x1b[38;2;170;0;0m');
  });

  it('256-color fallback emits a per-band ramp index', () => {
    assert.equal(heatAnsi(30, false), '\x1b[38;5;229m'); // yellow band, lightest
    assert.equal(heatAnsi(60, false), '\x1b[38;5;210m'); // red band, lightest
    assert.equal(heatAnsi(999, false), '\x1b[38;5;124m'); // deepest red
  });

  it('elapsedBadge wraps the label in the heat SGR + reset', () => {
    assert.equal(elapsedBadge(30, true), `\x1b[38;2;255;255;180m30m${ANSI_RESET}`);
  });

  it('formatElapsed: minutes then h/m', () => {
    assert.equal(formatElapsed(5), '5m');
    assert.equal(formatElapsed(59), '59m');
    assert.equal(formatElapsed(60), '1h');
    assert.equal(formatElapsed(72), '1h12m');
    assert.equal(formatElapsed(125), '2h05m');
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

  it('appends the runtime badge after the id when badgeFor returns one', () => {
    const badge = elapsedBadge(72, true);
    const line = formatSegment(
      'ECHO',
      ['ECHO-6309'],
      { done: 7, total: 8, pending: 0 },
      () => ICON.working,
      () => badge
    );
    assert.equal(line, `🎼 ECHO   7/8✓  ▶1 (${ICON.working} ECHO-6309 ${badge})  ⏳0`);
  });
});

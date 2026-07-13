/**
 * Unit tests for the maestro fleet status-line renderer's pure logic:
 *   - resolveTicketStatus: marker/status -> single STATUS key, severity order,
 *     freshness gating, nudge escalation, presence-based stuck-input.
 *   - runtime heat: per-band shade walk, hue jumps, 256 fallback, clock modes.
 *   - renderTicketCell: severity color placement (emoji vs text glyph modes).
 *   - formatSegment / readConfig / legendLine.
 *
 * Pure functions only — no tmux, no live conductor. Run with:
 *   node --test maestro-statusline.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  C,
  STATUS,
  ANSI_RESET,
  readConfig,
  heatAnsi,
  formatElapsed,
  elapsedBadge,
  elapsedMinutes,
  stuckActive,
  resolveTicketStatus,
  renderTicketCell,
  formatSegment,
  legendLine,
} = require('../maestro-statusline.js');

const NOW = 1_800_000_000; // fixed clock (seconds)

// Baseline config (emoji, truecolor, default thresholds) for the pure helpers.
const CFG = {
  glyphs: 'emoji',
  clock: 'age',
  truecolor: true,
  silenceLimitSec: 300,
  nudgeWindowSec: 30 * 60,
  overlayFreshSec: 300,
  stuckSanitySec: 12 * 3600,
  heatBounds: [30, 45, 60, 90],
};
const cfg = (over) => ({ ...CFG, ...over });

describe('resolveTicketStatus — severity + freshness', () => {
  it('working when the silence heartbeat is fresh', () => {
    const m = { silence: { lastActiveAt: NOW - 10 } };
    assert.equal(resolveTicketStatus(m, 'in_progress', NOW, CFG), 'working');
  });

  it('stalled when the heartbeat is older than the silence limit', () => {
    const m = { silence: { lastActiveAt: NOW - 305 } };
    assert.equal(resolveTicketStatus(m, 'in_progress', NOW, CFG), 'stalled');
  });

  it('question outranks a fresh working heartbeat', () => {
    const m = { question: { lastAlertAt: NOW - 5 }, silence: { lastActiveAt: NOW - 5 } };
    assert.equal(resolveTicketStatus(m, 'in_progress', NOW, CFG), 'question');
  });

  it('a stale question marker does NOT render (freshness gate)', () => {
    const m = { question: { lastAlertAt: NOW - 400 }, silence: { lastActiveAt: NOW - 5 } };
    assert.equal(resolveTicketStatus(m, 'in_progress', NOW, CFG), 'working');
  });

  it('nudge escalation: 1 -> nudge1, 2 -> nudge2, 3+ -> wedged', () => {
    const one = { restartLoop: { restarts: [NOW - 60] } };
    const two = { restartLoop: { restarts: [NOW - 120, NOW - 60] } };
    const three = { restartLoop: { restarts: [NOW - 180, NOW - 120, NOW - 60] } };
    assert.equal(resolveTicketStatus(one, 'in_progress', NOW, CFG), 'nudge1');
    assert.equal(resolveTicketStatus(two, 'in_progress', NOW, CFG), 'nudge2');
    assert.equal(resolveTicketStatus(three, 'in_progress', NOW, CFG), 'wedged');
  });

  it('nudges outside the restart window are ignored', () => {
    const m = {
      restartLoop: { restarts: [NOW - (CFG.nudgeWindowSec + 100)] },
      silence: { lastActiveAt: NOW - 5 },
    };
    assert.equal(resolveTicketStatus(m, 'in_progress', NOW, CFG), 'working');
  });

  it('dead-end killed -> wedged; pr-broken outranks nudges/working', () => {
    assert.equal(
      resolveTicketStatus(
        { deadEnd: { killed: true, freedAt: NOW - 60 } },
        'in_progress',
        NOW,
        CFG
      ),
      'wedged'
    );
    const m = {
      prStatus: { lastState: 'pr-broken' },
      restartLoop: { restarts: [NOW - 60] },
      silence: { lastActiveAt: NOW - 5 },
    };
    assert.equal(resolveTicketStatus(m, 'in_progress', NOW, CFG), 'prBroken');
  });

  it('pr-ready + status fallbacks', () => {
    assert.equal(
      resolveTicketStatus({ prStatus: { lastState: 'pr-ready' } }, 'in_progress', NOW, CFG),
      'prReady'
    );
    assert.equal(resolveTicketStatus({}, 'awaiting-merge', NOW, CFG), 'prReady');
    assert.equal(resolveTicketStatus({}, 'stopped', NOW, CFG), 'stopped');
    assert.equal(resolveTicketStatus({}, 'done', NOW, CFG), 'done');
    assert.equal(resolveTicketStatus({}, 'in_progress', NOW, CFG), 'working');
  });
});

describe('stuck-input is presence-based (#4)', () => {
  it('still flags after 40 min stuck (firstSeenAt does not refresh)', () => {
    const m = {
      stuckInput: { text: 'ping', firstSeenAt: NOW - 40 * 60 },
      silence: { lastActiveAt: NOW - 5 },
    };
    // Fresh heartbeat would otherwise say working; stuck outranks it and is not
    // gated by the short overlay window.
    assert.equal(resolveTicketStatus(m, 'in_progress', NOW, CFG), 'stuck');
    assert.equal(stuckActive(m.stuckInput, CFG, NOW), true);
  });

  it('drops a marker older than the sanity cap (orphaned by a dead conductor)', () => {
    const mk = { text: 'ping', firstSeenAt: NOW - (CFG.stuckSanitySec + 60) };
    assert.equal(stuckActive(mk, CFG, NOW), false);
  });
});

describe('runtime heat — per-band shade walk + clock (#2/#6)', () => {
  it('below the floor: no color', () => {
    assert.equal(heatAnsi(0, CFG), '');
    assert.equal(heatAnsi(29, CFG), '');
  });

  it('truecolor walks shades within a band, then jumps hue at boundaries', () => {
    assert.equal(heatAnsi(30, CFG), '\x1b[38;2;255;255;180m'); // yellow light
    assert.notEqual(heatAnsi(44, CFG), heatAnsi(30, CFG)); // yellow deepened
    assert.equal(heatAnsi(45, CFG), '\x1b[38;2;255;200;120m'); // hue jump → orange
    assert.equal(heatAnsi(60, CFG), '\x1b[38;2;255;90;90m'); // hue jump → red
    assert.equal(heatAnsi(999, CFG), '\x1b[38;2;170;0;0m'); // pinned deepest
  });

  it('256-color fallback emits per-band ramp indices', () => {
    const c = cfg({ truecolor: false });
    assert.equal(heatAnsi(30, c), '\x1b[38;5;229m');
    assert.equal(heatAnsi(60, c), '\x1b[38;5;210m');
    assert.equal(heatAnsi(999, c), '\x1b[38;5;124m');
  });

  it('configurable boundaries shift the floor', () => {
    const c = cfg({ heatBounds: [10, 20, 30, 40] });
    assert.equal(heatAnsi(9, c), '');
    assert.equal(heatAnsi(10, c), '\x1b[38;2;255;255;180m');
  });

  it('elapsedMinutes: age vs stall clock', () => {
    const src = { created: NOW - 3600, lastActiveAt: NOW - 600 };
    assert.equal(elapsedMinutes(cfg({ clock: 'age' }), src, NOW), 60);
    assert.equal(elapsedMinutes(cfg({ clock: 'stall' }), src, NOW), 10);
    // stall with no heartbeat falls back to age
    assert.equal(elapsedMinutes(cfg({ clock: 'stall' }), { created: NOW - 1800 }, NOW), 30);
    assert.equal(elapsedMinutes(CFG, {}, NOW), null);
  });

  it('elapsedBadge wraps label in heat SGR + reset; formatElapsed h/m', () => {
    assert.equal(elapsedBadge(30, CFG), `\x1b[38;2;255;255;180m30m${ANSI_RESET}`);
    assert.equal(elapsedBadge(12, CFG), '12m');
    assert.equal(formatElapsed(72), '1h12m');
    assert.equal(formatElapsed(60), '1h');
  });
});

describe('renderTicketCell — severity color placement (#1/#3)', () => {
  it('emoji mode: id tinted, emoji left uncolored', () => {
    const cell = renderTicketCell('working', 'ECHO-1', '', CFG);
    assert.equal(cell, `🔨 ${C.green}ECHO-1${C.reset}`);
  });

  it('text mode: both the glyph and the id are tinted', () => {
    const cell = renderTicketCell('wedged', 'ECHO-2', '', cfg({ glyphs: 'text' }));
    assert.equal(cell, `${C.red}x${C.reset} ${C.red}ECHO-2${C.reset}`);
  });

  it('appends the heat badge; bare id when status is empty', () => {
    const badge = elapsedBadge(72, CFG);
    assert.equal(
      renderTicketCell('working', 'ECHO-3', badge, CFG),
      `🔨 ${C.green}ECHO-3${C.reset} ${badge}`
    );
    assert.equal(renderTicketCell('', 'ECHO-4', '', CFG), 'ECHO-4');
  });
});

describe('formatSegment — envelope', () => {
  const cellFor = (id) => renderTicketCell('working', id, '', cfg({ glyphs: 'text' }));

  it('keeps the done/total ⏳ envelope with colored cells', () => {
    const line = formatSegment(
      'ECHO',
      ['ECHO-1', 'ECHO-2'],
      { done: 2, total: 8, pending: 4 },
      cellFor
    );
    const c1 = `${C.green}●${C.reset} ${C.green}ECHO-1${C.reset}`;
    const c2 = `${C.green}●${C.reset} ${C.green}ECHO-2${C.reset}`;
    assert.equal(line, `🎼 ECHO   2/8✓  ▶2 (${c1}, ${c2})  ⏳4`);
  });

  it('count-less fallback when no manifest matches', () => {
    const line = formatSegment('ECHO', ['ECHO-1'], null, cellFor);
    assert.equal(line, `🎼 ECHO   ▶  1  (${C.green}●${C.reset} ${C.green}ECHO-1${C.reset})`);
  });
});

describe('readConfig + legendLine', () => {
  it('parses env knobs with defaults', () => {
    const saved = { ...process.env };
    try {
      delete process.env.MAESTRO_STATUSLINE_GLYPHS;
      delete process.env.MAESTRO_HEAT_CLOCK;
      const d = readConfig();
      assert.equal(d.glyphs, 'emoji');
      assert.equal(d.clock, 'age');
      assert.deepEqual(d.heatBounds, [30, 45, 60, 90]);

      process.env.MAESTRO_STATUSLINE_GLYPHS = 'text';
      process.env.MAESTRO_HEAT_CLOCK = 'stall';
      process.env.MAESTRO_HEAT_WARN_MIN = '15';
      process.env.SILENCE_LIMIT_SEC = '120';
      const o = readConfig();
      assert.equal(o.glyphs, 'text');
      assert.equal(o.clock, 'stall');
      assert.equal(o.heatBounds[0], 15);
      assert.equal(o.silenceLimitSec, 120);
    } finally {
      process.env = saved;
    }
  });

  it('legendLine lists every status glyph', () => {
    const emoji = legendLine(CFG);
    assert.match(emoji, /🔨 working/);
    assert.match(emoji, /💀 wedged/);
    const text = legendLine(cfg({ glyphs: 'text' }));
    assert.match(text, /● working/);
    assert.match(text, /x wedged/);
    assert.equal(Object.keys(STATUS).length, 11);
  });
});

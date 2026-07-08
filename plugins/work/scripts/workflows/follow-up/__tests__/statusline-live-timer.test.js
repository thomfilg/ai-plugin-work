'use strict';

// statusline-live-timer.test.js — the status bar must recompute the elapsed
// timer at RENDER time (the pre-baked _ciStatusLine string froze the timer
// at whatever the last monitor cycle stringified).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildStatusLine,
  composeStatusLine,
  formatElapsed,
} = require('../lib/steps/monitor-status-line');

const RENDERER_SOURCE = fs.readFileSync(
  path.resolve(__dirname, '..', 'statusline', 'followup-statusline.js'),
  'utf8'
);

describe('monitor-status-line — structured parts', () => {
  const ci = {
    status: 'pending',
    running: [{ name: 'e2e' }],
    passed: [{ name: 'lint' }],
    failed: [],
    cancelled: [],
  };
  const reviews = { pendingBots: [], blocking: [], hasBlocking: false };

  it('buildStatusLine returns parts that recompose into line1', () => {
    const state = {
      attempt: 3,
      maxAttempts: 40,
      _monitorStartTime: new Date(Date.now() - 65000).toISOString(),
    };
    const { line1, parts } = buildStatusLine(state, ci, reviews);
    assert.equal(composeStatusLine(parts, formatElapsed(state._monitorStartTime)), line1);
    assert.equal(parts.poll, '3/40');
    assert.ok(parts.statusLabel.includes('CI'));
  });

  it('formatElapsed advances as time passes (the live-timer property)', () => {
    const start = new Date(Date.now() - 90 * 1000).toISOString();
    assert.equal(formatElapsed(start), '1m 30s');
    const older = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    assert.ok(formatElapsed(older).startsWith('2h'));
  });
});

describe('followup-statusline renderer', () => {
  it('recomputes elapsed from _ciStatusParts + _monitorStartTime instead of the frozen string', () => {
    assert.ok(RENDERER_SOURCE.includes('_ciStatusParts'), 'renderer reads structured parts');
    assert.ok(RENDERER_SOURCE.includes('formatElapsed'), 'renderer recomputes elapsed live');
    assert.ok(
      RENDERER_SOURCE.includes('composeStatusLine'),
      'renderer composes via the shared formatter'
    );
  });

  it('falls back to _ciStatusLine for state files written by older versions', () => {
    assert.ok(RENDERER_SOURCE.includes('_ciStatusLine'));
  });

  it('shows a marker when the persisted instruction is blocked/surface', () => {
    assert.ok(RENDERER_SOURCE.includes('.follow-up-next.json'));
    assert.ok(RENDERER_SOURCE.includes("'blocked'"));
    assert.ok(RENDERER_SOURCE.includes("'surface'"));
  });
});

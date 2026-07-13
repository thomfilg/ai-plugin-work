/**
 * Task 4 (GH-514) — detectors/silence.js per-skill silence threshold.
 *
 * Verifies AC4: silence.detect resolves limit per-call from:
 *   - process.env.SILENCE_LIMIT_SEC_FOLLOWUP when ctx.skill === 'follow-up'
 *   - skill-registry.get(ctx.skill).silenceLimitSec (default 1800 for follow-up)
 *   - process.env.SILENCE_LIMIT_SEC (work)
 *   - hard default 300
 *
 * Tests pre-seed state.write so the previous lastActiveAt is far enough in the
 * past to exceed the small-default limit but stay below the follow-up limit.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshTmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-silence-skill-'));
}

function loadDetectorFresh(stateDir, env = {}) {
  // Wipe module cache so module-level env reads (if any remained) don't leak
  // across cases. The whole point of Task 4 is the per-call read.
  const modPaths = [
    require.resolve('../lib/maestro-conduct/detectors/silence.js'),
    require.resolve('../lib/maestro-conduct/state.js'),
    require.resolve('../lib/maestro-conduct/skill-registry.js'),
    require.resolve('../lib/maestro-conduct/shared/skill-registry-rows.js'),
  ];
  for (const p of modPaths) delete require.cache[p];
  const saved = {
    STATE_DIR: process.env.STATE_DIR,
    SILENCE_LIMIT_SEC: process.env.SILENCE_LIMIT_SEC,
    SILENCE_LIMIT_SEC_FOLLOWUP: process.env.SILENCE_LIMIT_SEC_FOLLOWUP,
  };
  process.env.STATE_DIR = stateDir;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const silence = require('../lib/maestro-conduct/detectors/silence.js');
  const state = require('../lib/maestro-conduct/state.js');
  return {
    silence,
    state,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

function seedSilenceMarker({ state, session, pane, secondsAgo }) {
  // Pre-seed so isActive() returns false (same hash + same tokens) and
  // silenceSec equals secondsAgo.
  const crypto = require('node:crypto');
  const hash = crypto.createHash('md5').update(pane).digest('hex');
  const tokens = (pane.match(/(\d+)\s+tokens/g) || []).map((m) => parseInt(m, 10)).pop() ?? null;
  const now = Math.floor(Date.now() / 1000);
  state.write(session, 'silence', {
    hash,
    tokens,
    lastActiveAt: now - secondsAgo,
  });
}

test('Per-skill silence threshold honors SILENCE_LIMIT_SEC_FOLLOWUP', () => {
  const dir = freshTmpStateDir();
  const env = { SILENCE_LIMIT_SEC_FOLLOWUP: '1800', SILENCE_LIMIT_SEC: '300' };
  const { silence, state, restore } = loadDetectorFresh(dir, env);
  try {
    const session = 'GH-9001-work';
    const pane = 'idle pane content 42 tokens';
    seedSilenceMarker({ state, session, pane, secondsAgo: 600 });
    const result = silence.detect({ session, ticket: 'GH-9001', pane, skill: 'follow-up' });
    assert.equal(result.hit, false, 'follow-up at 600s should not hit (limit 1800)');
  } finally {
    restore();
  }
});

test('work skill with no SILENCE_LIMIT_SEC_FOLLOWUP override hits at 600s (default 300)', () => {
  const dir = freshTmpStateDir();
  const env = { SILENCE_LIMIT_SEC_FOLLOWUP: undefined, SILENCE_LIMIT_SEC: '300' };
  const { silence, state, restore } = loadDetectorFresh(dir, env);
  try {
    const session = 'GH-9001-work';
    const pane = 'idle pane content 42 tokens';
    seedSilenceMarker({ state, session, pane, secondsAgo: 600 });
    const result = silence.detect({ session, ticket: 'GH-9001', pane, skill: 'work' });
    assert.equal(result.hit, true, 'work at 600s with limit 300 should hit');
    assert.equal(result.kind, 'silence');
    assert.equal(result.limitSec, 300);
  } finally {
    restore();
  }
});

test('work skill honors SILENCE_LIMIT_SEC override above row default', () => {
  // PR #561 review regression: pre-GH-514, SILENCE_LIMIT_SEC was authoritative
  // for /work. The first cut consulted the registry row (300) before the env,
  // so an operator with SILENCE_LIMIT_SEC=600 saw their threshold silently
  // demoted to 300. Verify env takes precedence over the row for work.
  const dir = freshTmpStateDir();
  const env = { SILENCE_LIMIT_SEC_FOLLOWUP: undefined, SILENCE_LIMIT_SEC: '600' };
  const { silence, state, restore } = loadDetectorFresh(dir, env);
  try {
    const session = 'GH-9003-work';
    const pane = 'idle pane content 11 tokens';
    seedSilenceMarker({ state, session, pane, secondsAgo: 500 });
    const r1 = silence.detect({ session, ticket: 'GH-9003', pane, skill: 'work' });
    assert.equal(r1.hit, false, 'work at 500s with SILENCE_LIMIT_SEC=600 must NOT hit');

    seedSilenceMarker({ state, session, pane, secondsAgo: 700 });
    const r2 = silence.detect({ session, ticket: 'GH-9003', pane, skill: 'work' });
    assert.equal(r2.hit, true, 'work at 700s with SILENCE_LIMIT_SEC=600 must hit');
    assert.equal(
      r2.limitSec,
      600,
      'limitSec must come from SILENCE_LIMIT_SEC, not the row default'
    );
  } finally {
    restore();
  }
});

test('follow-up skill with NO env override uses registry default 1800s', () => {
  const dir = freshTmpStateDir();
  const env = { SILENCE_LIMIT_SEC_FOLLOWUP: undefined, SILENCE_LIMIT_SEC: undefined };
  const { silence, state, restore } = loadDetectorFresh(dir, env);
  try {
    const session = 'GH-9002-work';
    const pane = 'idle pane content 7 tokens';
    seedSilenceMarker({ state, session, pane, secondsAgo: 1200 });
    const result = silence.detect({ session, ticket: 'GH-9002', pane, skill: 'follow-up' });
    assert.equal(result.hit, false, 'follow-up at 1200s should not hit (registry default 1800)');
  } finally {
    restore();
  }
});

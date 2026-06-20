/**
 * Task 6 (GH-514) — integration: silence detector + skill-registry row
 * converge on a log line that names the active skill.
 *
 * Exercises silence.detect end-to-end with a seeded state marker and asserts
 * the `formatLogLine` output (which the daemon emits via alerts.log) matches
 * the documented `[GH-XXX:<skill>]` token shape from README.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function freshTmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-skill-log-'));
}

function loadFresh(stateDir, env = {}) {
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
  };
  process.env.STATE_DIR = stateDir;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return {
    silence: require('../lib/maestro-conduct/detectors/silence.js'),
    state: require('../lib/maestro-conduct/state.js'),
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

function seedSilence({ state, session, pane, secondsAgo }) {
  const hash = crypto.createHash('md5').update(pane).digest('hex');
  const tokens = (pane.match(/(\d+)\s+tokens/g) || []).map((m) => parseInt(m, 10)).pop() ?? null;
  state.write(session, 'silence', {
    hash,
    tokens,
    lastActiveAt: Math.floor(Date.now() / 1000) - secondsAgo,
  });
}

test('silence.detect + formatLogLine produce a [GH-XXX:work] line on work skill hit', () => {
  const dir = freshTmpStateDir();
  const env = { SILENCE_LIMIT_SEC: '300' };
  const { silence, state, restore } = loadFresh(dir, env);
  try {
    const session = 'GH-4242-work';
    const pane = 'idle 99 tokens';
    seedSilence({ state, session, pane, secondsAgo: 600 });
    const hit = silence.detect({ session, ticket: 'GH-4242', pane, skill: 'work' });
    assert.equal(hit.hit, true);
    const line = silence.formatLogLine({
      ticket: 'GH-4242',
      skill: 'work',
      silenceSec: hit.silenceSec,
      kind: 'silence',
    });
    assert.match(line, /\[GH-4242:work\]/);
    assert.match(line, /\[GH-\d+:(work|follow-up)\]/);
  } finally {
    restore();
  }
});

test('silence.detect + formatLogLine produce a [GH-XXX:follow-up] line on follow-up hit', () => {
  const dir = freshTmpStateDir();
  const env = { SILENCE_LIMIT_SEC_FOLLOWUP: '600' };
  const { silence, state, restore } = loadFresh(dir, env);
  try {
    const session = 'GH-7777-work';
    const pane = 'idle 7 tokens';
    seedSilence({ state, session, pane, secondsAgo: 1200 });
    const hit = silence.detect({ session, ticket: 'GH-7777', pane, skill: 'follow-up' });
    assert.equal(hit.hit, true, 'follow-up at 1200s with limit 600 must hit');
    const line = silence.formatLogLine({
      ticket: 'GH-7777',
      skill: 'follow-up',
      silenceSec: hit.silenceSec,
      kind: 'silence',
    });
    assert.match(line, /\[GH-7777:follow-up\]/);
  } finally {
    restore();
  }
});

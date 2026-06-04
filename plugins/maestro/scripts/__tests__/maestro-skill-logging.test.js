/**
 * Task 6 (GH-514) — R7: conductor log lines name the active skill.
 *
 * The silence detector exposes a `formatLogLine({ ticket, skill, silenceSec, kind })`
 * helper. Log lines must be prefixed with `[GH-XXX:<skill>]` so operators can
 * grep follow-up vs work activity without parsing the rest of the line.
 *
 * RED: the helper does not exist yet (or does not include the skill token).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const silence = require('../lib/maestro-conduct/detectors/silence.js');

test('silence.formatLogLine prefixes with [GH-XXX:<skill>] token for follow-up', () => {
  assert.equal(typeof silence.formatLogLine, 'function', 'formatLogLine must be exported');
  const line = silence.formatLogLine({
    ticket: 'GH-514',
    skill: 'follow-up',
    silenceSec: 120,
    kind: 'silence',
  });
  assert.match(
    line,
    /\[GH-514:follow-up\]/,
    'log line must include [GH-514:follow-up] skill token',
  );
  assert.match(line, /\[GH-\d+:(work|follow-up)\]/, 'must match the documented token shape');
  assert.match(line, /silence/, 'must mention the detector kind');
  assert.match(line, /120/, 'must include silence seconds');
});

test('silence.formatLogLine token uses skill=work when ctx.skill is "work"', () => {
  const line = silence.formatLogLine({
    ticket: 'GH-514',
    skill: 'work',
    silenceSec: 301,
    kind: 'silence',
  });
  assert.match(line, /\[GH-514:work\]/);
});

test('silence.formatLogLine falls back to skill=work when skill missing (non-regressive for /work)', () => {
  const line = silence.formatLogLine({
    ticket: 'GH-9999',
    silenceSec: 42,
    kind: 'silence',
  });
  assert.match(
    line,
    /\[GH-9999:work\]/,
    'missing skill must default to work so default /work logs are unchanged in shape',
  );
});

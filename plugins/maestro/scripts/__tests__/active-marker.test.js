/**
 * Unit tests for the status-bar active-marker writer in maestro-conduct.js.
 *
 * The bug: writeActiveMarker() required process.env.TICKET_PREFIX, which the
 * daemon launch frequently lacked, so no marker was written and the 🎼 status
 * bar stayed blank. The fix derives the prefix from the live `<PREFIX>-<id>-work`
 * tmux session list instead, honoring TICKET_PREFIX only when present.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { activeFleetPrefixes, writeActiveMarker } = require('../lib/maestro-conduct/active-marker');

const SAVED = {};
function stashEnv(keys) {
  for (const k of keys) SAVED[k] = process.env[k];
}
function restoreEnv() {
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
}

describe('activeFleetPrefixes', () => {
  beforeEach(() => stashEnv(['TICKET_PREFIX']));
  afterEach(restoreEnv);

  it('derives the prefix from live -work sessions (no env needed)', () => {
    delete process.env.TICKET_PREFIX;
    assert.deepEqual(activeFleetPrefixes(['FUT-97-work', 'FUT-95-work']), ['FUT']);
  });

  it('dedupes across sessions and helper suffixes', () => {
    delete process.env.TICKET_PREFIX;
    const out = activeFleetPrefixes(['FUT-97-work', 'FUT-97-dev', 'ECHO-12-work']);
    assert.deepEqual(out.sort(), ['ECHO', 'FUT']);
  });

  it('honors an explicit TICKET_PREFIX and unions it with live sessions', () => {
    process.env.TICKET_PREFIX = 'GH';
    const out = activeFleetPrefixes(['FUT-97-work']);
    assert.deepEqual(out.sort(), ['FUT', 'GH']);
  });

  it('ignores sessions with no ticket-shaped id and empty input', () => {
    delete process.env.TICKET_PREFIX;
    assert.deepEqual(activeFleetPrefixes(['random-session', 'holding']), []);
    assert.deepEqual(activeFleetPrefixes([]), []);
    assert.deepEqual(activeFleetPrefixes(undefined), []);
  });
});

describe('writeActiveMarker', () => {
  let home;
  beforeEach(() => {
    stashEnv(['TICKET_PREFIX', 'CLAUDE_CODE_SESSION_ID', 'REPO_NAME', 'HOME']);
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-marker-'));
    process.env.HOME = home;
    delete process.env.TICKET_PREFIX;
  });
  afterEach(() => {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const dir = () => path.join(home, '.cache', 'maestro', 'active');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir(), f), 'utf8'));

  it('writes one marker per derived prefix bound to the session', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-abc';
    process.env.REPO_NAME = 'future-pay';
    writeActiveMarker(['FUT-97-work', 'FUT-95-work']);
    assert.deepEqual(fs.readdirSync(dir()), ['sess-abc.FUT.json']);
    assert.deepEqual(read('sess-abc.FUT.json'), {
      session: 'sess-abc',
      prefix: 'FUT',
      repo: 'future-pay',
    });
  });

  it('no-ops without a session id', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    writeActiveMarker(['FUT-97-work']);
    assert.equal(fs.existsSync(dir()), false);
  });

  it('no-ops when no prefix can be derived (leaves nothing)', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-abc';
    writeActiveMarker(['holding-session']);
    assert.equal(fs.existsSync(dir()), false);
  });

  it('refreshes stale markers for the same session when the fleet changes', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-abc';
    writeActiveMarker(['FUT-97-work']);
    assert.deepEqual(fs.readdirSync(dir()), ['sess-abc.FUT.json']);
    // Fleet switches to a different prefix — the old marker must not linger.
    writeActiveMarker(['ECHO-3-work']);
    assert.deepEqual(fs.readdirSync(dir()), ['sess-abc.ECHO.json']);
  });

  it('does not disturb another session’s markers', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-one';
    writeActiveMarker(['FUT-97-work']);
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-two';
    writeActiveMarker(['ECHO-3-work']);
    assert.deepEqual(fs.readdirSync(dir()).sort(), ['sess-one.FUT.json', 'sess-two.ECHO.json']);
  });
});

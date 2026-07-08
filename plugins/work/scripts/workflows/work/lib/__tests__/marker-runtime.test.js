'use strict';

/**
 * Dual-runtime tests for marker ownership (WP-07): ownerStamp's session leg
 * falls back to AGENT_SESSION_ID — the runtime-neutral bridge hook processes
 * set for their children from payload.session_id (codex sets no CLAUDE_*
 * vars). findActiveMarker isolation must therefore work with payload-derived
 * session ids exactly as it does with CLAUDE_CODE_SESSION_ID.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ownerStamp, findActiveMarker } = require(path.resolve(__dirname, '..', 'marker.js'));

describe('marker — runtime-neutral session identity', () => {
  const saved = {};
  beforeEach(() => {
    saved.CLAUDE_CODE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID;
    saved.AGENT_SESSION_ID = process.env.AGENT_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.AGENT_SESSION_ID;
  });
  afterEach(() => {
    for (const key of ['CLAUDE_CODE_SESSION_ID', 'AGENT_SESSION_ID']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('ownerStamp uses AGENT_SESSION_ID when CLAUDE_CODE_SESSION_ID is unset (codex)', () => {
    process.env.AGENT_SESSION_ID = 'codex-sess-42';
    assert.equal(ownerStamp().sessionId, 'codex-sess-42');
  });

  it('ownerStamp prefers CLAUDE_CODE_SESSION_ID when both are set (claude byte-identity)', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'claude-sess-1';
    process.env.AGENT_SESSION_ID = 'codex-sess-42';
    assert.equal(ownerStamp().sessionId, 'claude-sess-1');
  });

  it('ownerStamp sessionId is null when neither env var is set (unchanged)', () => {
    assert.equal(ownerStamp().sessionId, null);
  });

  it('findActiveMarker isolates markers across payload-derived session ids', () => {
    const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-rt-'));
    try {
      const dirA = path.join(tasksBase, 'TEST-A');
      const dirB = path.join(tasksBase, 'TEST-B');
      fs.mkdirSync(dirA, { recursive: true });
      fs.mkdirSync(dirB, { recursive: true });
      fs.writeFileSync(
        path.join(dirA, '.work.pid'),
        JSON.stringify({ ticket: 'TEST-A', sessionId: 'codex-sess-A', worktreeRoot: null })
      );
      fs.writeFileSync(
        path.join(dirB, '.work.pid'),
        JSON.stringify({ ticket: 'TEST-B', sessionId: 'codex-sess-B', worktreeRoot: null })
      );

      const mine = findActiveMarker(tasksBase, '.work.pid', {
        sessionId: 'codex-sess-B',
        worktreeRoot: null,
      });
      assert.equal(mine && mine.ticket, 'TEST-B');

      const foreign = findActiveMarker(tasksBase, '.work.pid', {
        sessionId: 'codex-sess-C',
        worktreeRoot: null,
      });
      assert.equal(foreign, null);
    } finally {
      fs.rmSync(tasksBase, { recursive: true, force: true });
    }
  });
});

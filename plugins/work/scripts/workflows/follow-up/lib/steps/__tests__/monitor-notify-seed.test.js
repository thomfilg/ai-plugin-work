'use strict';

// monitor-notify-seed.test.js — notifyOnNewBlockingComments must SEED on the
// first observation (comments already present at workflow start are being
// actively processed; re-announcing them after every --init is noise) and
// notify only when the blocking count GROWS afterwards.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { notifyOnNewBlockingComments } = require('../monitor').__test__;
const { inboxPath } = require('../../notify');

describe('monitor — new-blocking-comment notifications', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-notify-'));
    process.env.CLAUDE_AGENT_INBOX_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.CLAUDE_AGENT_INBOX_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mailbox(ticket) {
    try {
      return fs.readFileSync(inboxPath(ticket), 'utf8');
    } catch {
      return '';
    }
  }

  it('first observation seeds the counter without notifying', () => {
    const state = { ticketId: 'GH-N1', prNumber: 9 };
    notifyOnNewBlockingComments(state, { blocking: [{}, {}, {}] });
    assert.equal(state._lastBlockingCount, 3);
    assert.equal(mailbox('GH-N1'), '', 'pre-existing comments must not be announced');
  });

  it('notifies when the count grows after seeding', () => {
    const state = { ticketId: 'GH-N2', prNumber: 9 };
    notifyOnNewBlockingComments(state, { blocking: [{}] }); // seed at 1
    notifyOnNewBlockingComments(state, { blocking: [{}, {}, {}] }); // 1 → 3
    const content = mailbox('GH-N2');
    assert.ok(content.includes('2 new blocking review comment(s)'), content);
    assert.equal(state._lastBlockingCount, 3);
  });

  it('does not notify when the count shrinks or holds', () => {
    const state = { ticketId: 'GH-N3', prNumber: 9 };
    notifyOnNewBlockingComments(state, { blocking: [{}, {}] }); // seed
    notifyOnNewBlockingComments(state, { blocking: [{}] }); // shrink
    notifyOnNewBlockingComments(state, { blocking: [{}] }); // hold
    assert.equal(mailbox('GH-N3'), '');
    assert.equal(state._lastBlockingCount, 1);
  });
});

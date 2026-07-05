'use strict';

// notify.test.js — operator mailbox notifications + inbound message reads.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { notifyOperator, readNewInboxMessages, inboxPath } = require('../notify');

describe('notify — operator mailbox', () => {
  let tmpDir;

  // Fixture writes go through this mkdtemp-rooted path (not inboxPath) so
  // CodeQL's insecure-temp-file taint from the '/tmp' fallback literal never
  // reaches a file-creation sink in the tests.
  const fixtureFile = (ticket) => path.join(tmpDir, `${ticket}.log`);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'));
    process.env.CLAUDE_AGENT_INBOX_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.CLAUDE_AGENT_INBOX_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('notifyOperator appends a tagged line to the ticket mailbox', () => {
    notifyOperator('GH-1', 'blocked: something went wrong');
    const content = fs.readFileSync(inboxPath('GH-1'), 'utf8');
    assert.ok(content.includes('[follow-up]'));
    assert.ok(content.includes('blocked: something went wrong'));
  });

  it('readNewInboxMessages: first sighting anchors the offset (no historical replay)', () => {
    fs.writeFileSync(fixtureFile('GH-2'), 'old operator chatter\n');
    const state = {};
    assert.deepEqual(readNewInboxMessages('GH-2', state), []);
    assert.equal(typeof state._inboxOffset, 'number');
  });

  it('readNewInboxMessages returns lines appended after the offset', () => {
    fs.writeFileSync(fixtureFile('GH-3'), 'old line\n');
    const state = {};
    readNewInboxMessages('GH-3', state); // anchor
    fs.appendFileSync(fixtureFile('GH-3'), 'please stop and rebase\n');
    assert.deepEqual(readNewInboxMessages('GH-3', state), ['please stop and rebase']);
    // Offset advanced — no re-serve on the next read.
    assert.deepEqual(readNewInboxMessages('GH-3', state), []);
  });

  it('readNewInboxMessages filters out follow-up-authored notifications', () => {
    const state = {};
    notifyOperator('GH-4', 'complete: all done'); // creates file with our tag
    readNewInboxMessages('GH-4', state); // anchor
    notifyOperator('GH-4', 'another self-notification');
    fs.appendFileSync(fixtureFile('GH-4'), 'real operator message\n');
    assert.deepEqual(readNewInboxMessages('GH-4', state), ['real operator message']);
  });

  it('readNewInboxMessages returns [] when the mailbox does not exist', () => {
    assert.deepEqual(readNewInboxMessages('GH-none', {}), []);
  });

  it('a message that CREATES the mailbox mid-wait is not missed (ENOENT anchors at 0)', () => {
    const state = {};
    assert.deepEqual(readNewInboxMessages('GH-5', state), []); // no file yet — anchors 0
    assert.equal(state._inboxOffset, 0);
    fs.writeFileSync(fixtureFile('GH-5'), 'first ever operator message\n');
    assert.deepEqual(readNewInboxMessages('GH-5', state), ['first ever operator message']);
  });
});

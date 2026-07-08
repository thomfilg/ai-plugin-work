// purgeAlertCountsForTicket must match the ticket on a boundary, not as a
// substring. Alert keys are `${session}|${kind}|${sha-or-phase}` where the
// session is `${ticket}` or `${ticket}-work` / `${ticket}-listen`, so a naive
// `key.includes(ticket)` would purge GH-10 / GH-11 counts when cleaning GH-1.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function freshCleanup(stateDir) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('maestro-cleanup')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  return require(path.resolve(__dirname, '..', 'maestro-cleanup'));
}

test('purgeAlertCountsForTicket only removes exact ticket-boundary keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-purge-'));
  const file = path.join(dir, '_alert-counts.json');
  const counts = {
    'GH-1|wedged|_': 1,
    'GH-1-work|silence|abc': 2,
    'GH-1-listen|stall|def': 3,
    'GH-10|wedged|_': 4,
    'GH-10-work|silence|xyz': 5,
    'GH-11-work|wedged|_': 6,
    'OTHER|wedged|_': 7,
  };
  fs.writeFileSync(file, JSON.stringify(counts));

  const { purgeAlertCountsForTicket } = freshCleanup(dir);
  const removed = purgeAlertCountsForTicket('GH-1', false);

  assert.equal(removed, 3, 'should remove exactly the three GH-1* keys');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after).sort(), [
    'GH-10-work|silence|xyz',
    'GH-10|wedged|_',
    'GH-11-work|wedged|_',
    'OTHER|wedged|_',
  ]);
});

test('purgeAlertCountsForTicket dry-run leaves file untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-purge-dry-'));
  const file = path.join(dir, '_alert-counts.json');
  const counts = { 'GH-1|wedged|_': 1, 'GH-10|wedged|_': 2 };
  fs.writeFileSync(file, JSON.stringify(counts));

  const { purgeAlertCountsForTicket } = freshCleanup(dir);
  const removed = purgeAlertCountsForTicket('GH-1', true);

  assert.equal(removed, 1);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after, counts, 'dry-run must not modify the file');
});

test('purgeAlertCountsForTicket escapes regex metacharacters in ticket', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-purge-esc-'));
  const file = path.join(dir, '_alert-counts.json');
  // `.` is a regex metachar — must be escaped so it doesn't match arbitrary chars.
  const counts = {
    'A.B|wedged|_': 1,
    'AXB|wedged|_': 2,
  };
  fs.writeFileSync(file, JSON.stringify(counts));

  const { purgeAlertCountsForTicket } = freshCleanup(dir);
  const removed = purgeAlertCountsForTicket('A.B', false);

  assert.equal(removed, 1);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after), ['AXB|wedged|_']);
});

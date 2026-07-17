/**
 * Integration test for the three Phase-1 reference extensions wired through
 * the public initExtensions() entry point (Task 4) against a fixture repo
 * containing real reference files copied from plugins/work/references/.
 *
 * Covers Task 10 acceptance criteria (loader + dispatch end-to-end).
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REFERENCES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'references',
  'work-extensions'
);
const INDEX_PATH = path.resolve(__dirname, '..', 'index.js');
const EVENT_BUS_PATH = path.resolve(__dirname, '..', 'event-bus.js');

function freshRequire(p) {
  delete require.cache[require.resolve(p)];
  return require(p);
}

function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refext-int-'));
  const tasksDir = path.join(root, 'tasks', 'GH-522');
  fs.mkdirSync(tasksDir, { recursive: true });
  const extDir = path.join(root, '.claude', 'work-extensions');
  fs.mkdirSync(extDir, { recursive: true });
  return { root, tasksDir, extDir };
}

function copyRef(name, extDir) {
  fs.copyFileSync(path.join(REFERENCES_DIR, name), path.join(extDir, name));
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  return Promise.resolve()
    .then(() => fn())
    .then((result) => {
      process.stderr.write = original;
      return { result, stderr: chunks.join('') };
    })
    .catch((err) => {
      process.stderr.write = original;
      throw err;
    });
}

describe('reference extensions — initExtensions integration', () => {
  let tmpDirs = [];

  beforeEach(() => {
    tmpDirs = [];
    // Reset shared event-bus state across tests.
    freshRequire(EVENT_BUS_PATH);
  });

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('initExtensions discovers and dispatches the three references end-to-end', async () => {
    const { root, tasksDir, extDir } = makeTempRepo();
    tmpDirs.push(root);
    copyRef('cortex-auto-recall.js', extDir);
    copyRef('flaky-test-runbook.js', extDir);
    copyRef('rulesync-redirect.js', extDir);

    // Freshly require to drop any memoization.
    freshRequire(EVENT_BUS_PATH);
    const { initExtensions } = freshRequire(INDEX_PATH);

    const { result: api, stderr } = await captureStderr(() =>
      initExtensions({ repoRoot: root, tasksDir })
    );

    const status = api.status();
    assert.equal(status.length, 3);
    for (const entry of status) {
      assert.equal(entry.loaded, true, `${entry.file} failed: ${entry.error || ''}`);
    }
    assert.match(stderr, /Phase 3 not yet enabled/i);

    // Dispatch OnTicketResolved → cortex-auto-recall should not throw.
    await api.dispatch('OnTicketResolved', { ticketId: 'GH-7' });
  });
});

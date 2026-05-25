/**
 * wait-no-dev-banner.test.js
 *
 * The ci/wait and ci/wait_merge phases are poll-only / merge-only. The
 * instructions text must explicitly forbid spawning developer agents during
 * these phases — without the banner, orchestrators misroute and spawn
 * developer-nodejs-tdd while CI is just running or while waiting for a
 * human merge (observed in ECHO-5218).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wait = require('../lib/phases/wait');
const wait_merge = require('../lib/phases/wait_merge');

function makeCtx(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const tasksDir = path.join(root, 'tasks', 'ECHO-NODEV');
  fs.mkdirSync(tasksDir, { recursive: true });
  return { root, tasksDir, worktreeRoot: root, ticket: 'ECHO-NODEV' };
}

test('wait.instructions includes POLL-ONLY banner forbidding dev agents', () => {
  const ctx = makeCtx('ci-wait-banner');
  try {
    const text = wait.instructions(ctx);
    assert.match(text, /POLL-ONLY/, 'wait phase must declare POLL-ONLY');
    assert.match(text, /do not spawn/i, 'wait phase must forbid spawning agents');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('wait_merge.instructions includes WAITING FOR HUMAN MERGE banner', () => {
  const ctx = makeCtx('ci-waitmerge-banner');
  try {
    const text = wait_merge.instructions(ctx);
    assert.match(text, /WAITING FOR HUMAN MERGE/, 'wait_merge must declare HUMAN-MERGE wait');
    assert.match(text, /do not spawn/i, 'wait_merge must forbid spawning agents');
    assert.match(text, /(merge|merged)/i, 'wait_merge must mention merge requirement explicitly');
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
});

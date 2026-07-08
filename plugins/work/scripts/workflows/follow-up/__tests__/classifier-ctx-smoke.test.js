'use strict';

/**
 * Structural smoke test: `lib/classifier-ctx.js` is reachable in isolation,
 * exposes the documented contract, and mirrors `state._ciFailedTests` onto
 * `state.failedTests` (the deliberate back-compat state mutation).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('lib/classifier-ctx — smoke (isolated require)', () => {
  it('exports buildExecForCtx and buildClassifierCtx', () => {
    const mod = require('../lib/classifier-ctx');
    assert.equal(typeof mod.buildExecForCtx, 'function');
    assert.equal(typeof mod.buildClassifierCtx, 'function');
  });

  it('buildClassifierCtx surfaces the documented fields and mirrors failedTests onto state', () => {
    const { buildClassifierCtx } = require('../lib/classifier-ctx');
    const state = {
      _ciFailedJobs: [{ runId: '987', jobId: '111' }],
      _ciAllJobs: [{ name: 'shard-1' }, { name: 'shard-2' }],
      _ciFailedLogs: 'cache: MISS\n',
      _ciFailedTests: ['src/foo.test.ts'],
      _ciStatus: 'failing',
    };
    const ctx = buildClassifierCtx(state, '/nonexistent/path');
    assert.equal(typeof ctx.exec, 'function');
    assert.ok(Array.isArray(ctx.allJobs));
    assert.equal(ctx.allJobs.length, 2);
    assert.ok(Array.isArray(ctx.prDiffFiles)); // fails open with [] on bad path
    assert.equal(ctx.rawLogs, 'cache: MISS\n');
    assert.equal(ctx.runId, '987');
    assert.equal(ctx.jobId, '111');
    assert.equal(ctx.ciStatus, 'failing');
    assert.deepEqual(state.failedTests, ['src/foo.test.ts'], 'mirrors onto state.failedTests');
  });
});

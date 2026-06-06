'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  classify,
  __test__: {
    signal1_shardAsymmetry,
    signal2_emptyFailedLog,
    signal3_unrelatedFailures,
    signal4_setupArtifacts,
  },
} = require('../lib/infra-classifier');

describe('infra-classifier', () => {
  describe('signal1_shardAsymmetry', () => {
    it('fires on a 4-shard matrix where 1 shard fails at 6min while sibling median is 1min', () => {
      const baseStart = new Date('2026-01-01T00:00:00.000Z').getTime();
      const mkJob = (name, runtimeMin, conclusion) => ({
        name,
        conclusion,
        startedAt: new Date(baseStart).toISOString(),
        completedAt: new Date(baseStart + runtimeMin * 60_000).toISOString(),
      });
      const allJobs = [
        mkJob('e2e [shard-1]', 1, 'success'),
        mkJob('e2e [shard-2]', 1, 'success'),
        mkJob('e2e [shard-3]', 1, 'success'),
        mkJob('e2e [shard-4]', 6, 'failure'),
      ];
      const failedJobs = [allJobs[3]];
      const result = signal1_shardAsymmetry(failedJobs, allJobs);
      assert.equal(result.fired, true);
      assert.ok(result.evidence, 'evidence should be present');
    });

    it('Bug 542-25: excludes the failed shard from the sibling median by id/name, not reference', () => {
      // `enrichFailedFromAll` returns a COPY of the failed job, so the
      // `j !== failed` reference check used to fail and the failed shard's
      // 6min runtime got included in the median — pulling the median up and
      // blocking the ≥3× asymmetry check.
      const baseStart = new Date('2026-01-01T00:00:00.000Z').getTime();
      const mkAllJob = (name, runtimeMin, conclusion, databaseId) => ({
        name,
        databaseId,
        conclusion,
        startedAt: new Date(baseStart).toISOString(),
        completedAt: new Date(baseStart + runtimeMin * 60_000).toISOString(),
      });
      // 3-shard family: shards 1+2 run 1min, shard 3 runs 6min and fails.
      // With proper exclusion, median(siblings) = 1min, ratio = 6 → fires.
      // With reference-equality bug, median(all 3) = 1min still (the failed
      // is a copy so it's in the set — median of [1,1,6] = 1; ratio 6 → fires).
      // Actually with 3 entries and copy bug, the failed shard's copy is in
      // the family too because allJobs has the original. Make this stronger:
      // use 4-shard family where dropping the failed flips the ratio decision.
      const allJobs = [
        mkAllJob('e2e [shard-1]', 1, 'success', 1001),
        mkAllJob('e2e [shard-2]', 1, 'success', 1002),
        mkAllJob('e2e [shard-3]', 3, 'success', 1003),
        mkAllJob('e2e [shard-4]', 6, 'failure', 1004),
      ];
      // Failed entry is an enriched copy (no shared reference).
      const failedJobs = [
        {
          name: 'e2e [shard-4]',
          jobId: '1004',
          // Pretend monitor pre-enriched (production may do this).
          startedAt: new Date(baseStart).toISOString(),
          completedAt: new Date(baseStart + 6 * 60_000).toISOString(),
        },
      ];
      const result = signal1_shardAsymmetry(failedJobs, allJobs);
      // siblings = [1,1,3] median=1; ratio = 6/1 = 6 ≥ 3 → fire.
      // Buggy: siblings = [1,1,3,6] median=2; ratio = 6/2 = 3 ≥ 3 → still fires
      // BUT evidence.siblingMedianMs differs. Assert the median value.
      assert.equal(result.fired, true);
      // 60_000ms = 1 minute. Median of [1,1,3] in ms is 60_000.
      assert.equal(
        result.evidence.siblingMedianMs,
        60_000,
        'failed shard must NOT inflate the sibling median'
      );
    });

    it('Bug 542-23: enriches failed-job timestamps by matching jobId against allJobs.databaseId', () => {
      // monitor.js attaches jobId (gh databaseId) to _ciFailedJobs entries
      // but leaves _ciAllJobs verbatim (databaseId field). Without the
      // id-based match working, the failed entry — which has NO startedAt /
      // completedAt — gets jobRuntimeMs=0 and signal1 cannot fire.
      const baseStart = new Date('2026-01-01T00:00:00.000Z').getTime();
      const mkAllJob = (name, runtimeMin, conclusion, databaseId) => ({
        name,
        databaseId,
        conclusion,
        startedAt: new Date(baseStart).toISOString(),
        completedAt: new Date(baseStart + runtimeMin * 60_000).toISOString(),
      });
      const allJobs = [
        mkAllJob('e2e [shard-1]', 1, 'success', 1001),
        mkAllJob('e2e [shard-2]', 1, 'success', 1002),
        mkAllJob('e2e [shard-3]', 1, 'success', 1003),
        mkAllJob('e2e [shard-4]', 6, 'failure', 1004),
      ];
      // Failed entry has jobId (from monitor.attachJobIds) but no timestamps
      // — they live only on _ciAllJobs. The fix matches failed.jobId against
      // allJob.databaseId to enrich. Name set so family lookup still works.
      const failedJobs = [{ name: 'e2e [shard-4]', jobId: '1004' }];
      const result = signal1_shardAsymmetry(failedJobs, allJobs);
      assert.equal(
        result.fired,
        true,
        'signal1 must enrich timestamps by databaseId match and detect asymmetry'
      );
    });

    it('iterates all failed jobs — small family for job A does not abort check on job B in a larger family', () => {
      const baseStart = new Date('2026-01-01T00:00:00.000Z').getTime();
      const mkJob = (name, runtimeMin, conclusion) => ({
        name,
        conclusion,
        startedAt: new Date(baseStart).toISOString(),
        completedAt: new Date(baseStart + runtimeMin * 60_000).toISOString(),
      });
      // Job A's family has only 2 shards (cannot establish asymmetry). Job B's
      // family has 5 shards with the failing one running 6x the median.
      const allJobs = [
        mkJob('lint [shard-1]', 1, 'success'),
        mkJob('lint [shard-2]', 1, 'failure'),
        mkJob('e2e [shard-1]', 1, 'success'),
        mkJob('e2e [shard-2]', 1, 'success'),
        mkJob('e2e [shard-3]', 1, 'success'),
        mkJob('e2e [shard-4]', 1, 'success'),
        mkJob('e2e [shard-5]', 6, 'failure'),
      ];
      const failedJobs = [allJobs[1], allJobs[6]];
      const result = signal1_shardAsymmetry(failedJobs, allJobs);
      assert.equal(
        result.fired,
        true,
        'signal1 must fire on job B even though job A is in a <3-shard family'
      );
      assert.equal(result.evidence.family, 'e2e');
    });

    it('does NOT fire on a 2-way matrix (N<3) — rejects with reason in evidence', () => {
      const baseStart = new Date('2026-01-01T00:00:00.000Z').getTime();
      const mkJob = (name, runtimeMin, conclusion) => ({
        name,
        conclusion,
        startedAt: new Date(baseStart).toISOString(),
        completedAt: new Date(baseStart + runtimeMin * 60_000).toISOString(),
      });
      const allJobs = [mkJob('e2e [shard-1]', 1, 'success'), mkJob('e2e [shard-2]', 6, 'failure')];
      const failedJobs = [allJobs[1]];
      const result = signal1_shardAsymmetry(failedJobs, allJobs);
      assert.equal(result.fired, false);
      assert.ok(
        result.evidence && /matrix|N<3|shard|<3/i.test(JSON.stringify(result.evidence)),
        'evidence should state the N<3 rejection reason'
      );
    });
  });

  describe('signal2_emptyFailedLog', () => {
    it('fires when gh run view --log-failed returns empty stdout but conclusion=failure', () => {
      const exec = (_cmd) => ({ stdout: '', stderr: '', status: 0 });
      const result = signal2_emptyFailedLog('123456', '789012', exec);
      assert.equal(result.fired, true);
    });

    it('does NOT fire when stdout contains an assertion / error text', () => {
      const exec = (_cmd) => ({
        stdout: 'Error: expect(received).toBe(expected)',
        stderr: '',
        status: 0,
      });
      const result = signal2_emptyFailedLog('123456', '789012', exec);
      assert.equal(result.fired, false);
    });

    it('throws TypeError on malformed jobId (non-numeric)', () => {
      const exec = (_cmd) => ({ stdout: '', stderr: '', status: 0 });
      assert.throws(() => signal2_emptyFailedLog('123456', 'abc; rm -rf /', exec), TypeError);
    });

    it('throws TypeError on malformed runId (non-numeric)', () => {
      const exec = (_cmd) => ({ stdout: '', stderr: '', status: 0 });
      assert.throws(() => signal2_emptyFailedLog('not-a-number', '789012', exec), TypeError);
    });
  });

  describe('signal3_unrelatedFailures', () => {
    it('fires when failing specs do not overlap with PR diff files', () => {
      const failedTests = [
        'src/unrelated/a.spec.ts',
        'src/unrelated/b.spec.ts',
        'src/unrelated/c.spec.ts',
        'src/unrelated/d.spec.ts',
      ];
      const prDiffFiles = ['src/foo.ts'];
      const result = signal3_unrelatedFailures(failedTests, prDiffFiles);
      assert.equal(result.fired, true);
    });

    it('does NOT fire when a failing spec shares a path with the diff', () => {
      const failedTests = ['src/foo.spec.ts', 'src/unrelated/b.spec.ts'];
      const prDiffFiles = ['src/foo.ts'];
      const result = signal3_unrelatedFailures(failedTests, prDiffFiles);
      assert.equal(result.fired, false);
    });

    it('PR #542 cursor[bot]: realistic populated shape — state.failedTests flows in from CI log extraction', () => {
      // Simulates the new pipeline: monitor.js extracts paths from raw logs
      // into state._ciFailedTests; follow-up-next.js mirrors onto
      // state.failedTests; classify reads s.failedTests. End-to-end realism.
      const state = {
        _ciFailedJobs: [],
        failedTests: [
          'plugins/work/scripts/workflows/follow-up/__tests__/unrelated.test.js',
          'apps/web/src/unrelated/foo.spec.tsx',
        ],
      };
      const ctx = {
        allJobs: [],
        prDiffFiles: ['src/payment/checkout.ts'],
        rawLogs: ['e2e-deps cache: MISS', 'fallback install FAILED'].join('\n'),
        exec: () => ({ stdout: 'real assertion', stderr: '', status: 0 }),
        jobId: '222',
      };
      const result = classify(state, ctx);
      assert.ok(result.signals.includes('signal3'));
      assert.equal(result.classification, 'infra-suspected');
    });
  });

  describe('signal4_setupArtifacts', () => {
    it('fires when raw log has "e2e-deps cache: MISS" + "fallback install FAILED"', () => {
      const rawLogs = ['some setup line', 'e2e-deps cache: MISS', 'fallback install FAILED'].join(
        '\n'
      );
      const result = signal4_setupArtifacts(rawLogs);
      assert.equal(result.fired, true);
    });

    it('does NOT fire when raw log is plain assertion text', () => {
      const rawLogs = ['Error: expect(received).toBe(expected)', 'FAIL src/foo.spec.ts'].join('\n');
      const result = signal4_setupArtifacts(rawLogs);
      assert.equal(result.fired, false);
    });
  });

  describe('classify()', () => {
    const baseStart = new Date('2026-01-01T00:00:00.000Z').getTime();
    const mkJob = (name, runtimeMin, conclusion) => ({
      name,
      conclusion,
      startedAt: new Date(baseStart).toISOString(),
      completedAt: new Date(baseStart + runtimeMin * 60_000).toISOString(),
    });

    it('returns infra-suspected when signal1 + signal2 both fire', () => {
      const allJobs = [
        mkJob('e2e [shard-1]', 1, 'success'),
        mkJob('e2e [shard-2]', 1, 'success'),
        mkJob('e2e [shard-3]', 1, 'success'),
        mkJob('e2e [shard-4]', 6, 'failure'),
      ];
      const state = { _ciFailedJobs: [allJobs[3]], runId: '111' };
      const ctx = {
        allJobs,
        prDiffFiles: ['src/foo.ts'],
        rawLogs: 'Error: assertion',
        exec: (_cmd) => ({ stdout: '', stderr: '', status: 0 }),
        jobId: '222',
      };
      const result = classify(state, ctx);
      assert.equal(result.classification, 'infra-suspected');
      assert.ok(Array.isArray(result.signals));
      assert.ok(result.signals.includes('signal1'));
      assert.ok(result.signals.includes('signal2'));
    });

    it('returns code-failure when only one signal fires', () => {
      const allJobs = [mkJob('unit', 1, 'failure')];
      const state = { _ciFailedJobs: [allJobs[0]], runId: '111' };
      const ctx = {
        allJobs,
        prDiffFiles: ['src/foo.ts'],
        rawLogs: 'Error: real assertion',
        exec: (_cmd) => ({
          stdout: 'Error: expect(received).toBe(expected)',
          stderr: '',
          status: 0,
        }),
        jobId: '222',
      };
      const result = classify(state, ctx);
      assert.equal(result.classification, 'code-failure');
    });

    it('returns infra-suspected when signal3 + signal4 both fire', () => {
      const state = {
        _ciFailedJobs: [],
        failedTests: [
          'src/unrelated/a.spec.ts',
          'src/unrelated/b.spec.ts',
          'src/unrelated/c.spec.ts',
        ],
        runId: '111',
      };
      const ctx = {
        allJobs: [],
        prDiffFiles: ['src/foo.ts'],
        rawLogs: ['e2e-deps cache: MISS', 'fallback install FAILED'].join('\n'),
        exec: (_cmd) => ({
          stdout: 'Error: real assertion present',
          stderr: '',
          status: 0,
        }),
        jobId: '222',
      };
      const result = classify(state, ctx);
      assert.equal(result.classification, 'infra-suspected');
      assert.ok(result.signals.includes('signal3'));
      assert.ok(result.signals.includes('signal4'));
    });

    it('Bug C: signal2 reads runId/jobId from ctx (production shape) without throwing', () => {
      // monitor.js shape: _ciFailedJobs[i] = { name, runId, jobId } — NO state.runId.
      const state = {
        _ciFailedJobs: [{ name: 'unit', runId: '12345', jobId: '67890' }],
        failedTests: [],
      };
      const ctx = {
        allJobs: [],
        prDiffFiles: ['src/foo.ts'],
        rawLogs: '',
        exec: (_cmd) => ({ stdout: '', stderr: '', status: 0 }),
        runId: '12345',
        jobId: '67890',
      };
      // Must not throw — signal2 must accept ctx.runId/ctx.jobId.
      const result = classify(state, ctx);
      assert.ok(result, 'classify returns a result');
      // signal2 should have evaluated successfully (fired=true on empty stdout
      // with no error markers) — proves the IDs flowed through.
      assert.ok(
        result.signals.includes('signal2'),
        'signal2 must have fired with ctx.runId/jobId passed through'
      );
    });

    it('Bug C: classify skips signal2 cleanly (no throw) when ctx has no IDs', () => {
      const state = { _ciFailedJobs: [], failedTests: [] };
      const ctx = {
        allJobs: [],
        prDiffFiles: [],
        rawLogs: '',
        exec: (_cmd) => ({ stdout: '', stderr: '', status: 0 }),
        // No runId, no jobId.
      };
      // Must not throw: previously signal2 called the ID regex on undefined.
      assert.doesNotThrow(() => classify(state, ctx));
      const result = classify(state, ctx);
      assert.equal(result.classification, 'code-failure');
    });

    it('returns infra-suspected when signal2 + signal4 both fire', () => {
      const state = {
        _ciFailedJobs: [],
        failedTests: ['src/foo.spec.ts'],
        runId: '111',
      };
      const ctx = {
        allJobs: [],
        prDiffFiles: ['src/foo.ts'],
        rawLogs: ['e2e-deps cache: MISS', 'fallback install FAILED'].join('\n'),
        exec: (_cmd) => ({ stdout: '', stderr: '', status: 0 }),
        jobId: '222',
      };
      const result = classify(state, ctx);
      assert.equal(result.classification, 'infra-suspected');
      assert.ok(result.signals.includes('signal2'));
      assert.ok(result.signals.includes('signal4'));
    });
  });
});

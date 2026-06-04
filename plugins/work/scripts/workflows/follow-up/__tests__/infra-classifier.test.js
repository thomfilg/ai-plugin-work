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

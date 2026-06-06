'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { stripGhPrefix, filterLogs } = require('../lib/log-utils');

describe('log-utils', () => {
  describe('stripGhPrefix', () => {
    it('strips the "<job>\\t<step>\\t<ISO timestamp>\\t" GitHub log prefix', () => {
      const line =
        'unit-tests\tRun tests\t2026-05-12T10:14:53.123Z Error: expected true to be false';
      const result = stripGhPrefix(line);
      assert.equal(result, 'Error: expected true to be false');
    });

    it('returns the original line unchanged when no gh prefix is present', () => {
      const line = 'plain log line without prefix';
      const result = stripGhPrefix(line);
      assert.equal(result, 'plain log line without prefix');
    });

    it('handles multiple job/step variants in the prefix', () => {
      const line =
        'e2e-tests [shard-1]\tUNKNOWN STEP\t2026-01-15T08:00:00.000Z playwright FAIL src/foo.spec.ts';
      const result = stripGhPrefix(line);
      assert.equal(result, 'playwright FAIL src/foo.spec.ts');
    });
  });

  describe('filterLogs', () => {
    it('drops blank lines from the raw logs', () => {
      const raw = ['', '   ', 'Error: something failed', ''].join('\n');
      const result = filterLogs(raw);
      assert.ok(
        result.includes('Error: something failed'),
        `expected error line preserved, got: ${result}`
      );
      // Blank lines should not appear as standalone lines in the result.
      const lines = result.split('\n');
      for (const line of lines) {
        assert.ok(line.trim().length > 0, `unexpected blank line in result: "${line}"`);
      }
    });

    it('drops ##[group] / ##[endgroup] noise lines', () => {
      const raw = [
        '##[group]Run actions/checkout@v4',
        '##[endgroup]',
        'Error: assertion failed at foo.test.js',
      ].join('\n');
      const result = filterLogs(raw);
      assert.ok(!result.includes('##[group]'), 'expected ##[group] noise removed');
      assert.ok(!result.includes('##[endgroup]'), 'expected ##[endgroup] noise removed');
      assert.ok(
        result.includes('Error: assertion failed at foo.test.js'),
        'expected error line preserved'
      );
    });

    it('keeps lines containing error / fail / expect markers', () => {
      const raw = [
        'Runner Image: ubuntu-22.04',
        'expect(received).toBe(expected)',
        'FAIL src/example.spec.ts',
      ].join('\n');
      const result = filterLogs(raw);
      assert.ok(!result.includes('Runner Image'), 'runner noise should be dropped');
      assert.ok(result.includes('expect(received).toBe(expected)'), 'expect line preserved');
      assert.ok(result.includes('FAIL src/example.spec.ts'), 'FAIL line preserved');
    });

    it('strips the gh prefix before applying the noise filter', () => {
      const raw = [
        'unit-tests\tRun tests\t2026-05-12T10:14:53.123Z Error: boom',
        'unit-tests\tRun tests\t2026-05-12T10:14:54.123Z ##[group]Setup',
      ].join('\n');
      const result = filterLogs(raw);
      assert.ok(result.includes('Error: boom'), 'gh-prefixed error preserved');
      assert.ok(!result.includes('##[group]'), 'gh-prefixed noise dropped');
      assert.ok(!result.includes('2026-05-12T10:14:53'), 'timestamp prefix stripped');
    });
  });
});

'use strict';

/**
 * Regression test for the `filterLogs` predicate extracted from `fix-ci.js`.
 * The refactor introduced a `shouldKeepLine` helper; this test locks in
 * byte-equivalent behavior so future edits cannot silently corrupt what the
 * developer-nodejs-tdd agent sees on a fix-ci dispatch.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { filterLogs } = require('../lib/log-utils');

// One representative line per allow pattern.
const ALLOW_LINES = [
  'AssertionError: expected 1 to equal 2', // error|fail|assert|expect|...
  'src/components/foo.spec.ts:42:11 — failure', // \.(spec|test)\.(ts|js|tsx|jsx)
  '    at Object.<anonymous> (/path/to/file.js:10:5)', // ^\s+at\s
  'Process completed with exit code 1', // exit code|...
  'Run tests with coverage', // Run tests|Run e2e|playwright
];

// One representative line per deny pattern.
const DENY_LINES = [
  '##[group]Set up job', // group/endgroup/Runner Image/OS
  'Runner version: 2.310.2', // runner version|Secret source|...
  'Image: ubuntu-22.04', // Image:|Version:|Commit:|...
  'Permissions for GITHUB_TOKEN', // Permissions|Actions: read|...
  'Temporarily overriding HOME', // Temporarily overriding HOME|...
  '[command]/usr/bin/git config --global', // \[command\]/usr/bin/git
  'Cleaning up orphan processes', // RESOLVEDSTATS|Cleaning up orphan|...
];

describe('log-utils filterLogs — regression lock', () => {
  it('preserves every allow-pattern line', () => {
    const input = [...ALLOW_LINES, ...DENY_LINES].join('\n');
    const out = filterLogs(input);
    for (const line of ALLOW_LINES) {
      assert.ok(out.includes(line), `allow line missing from output: "${line}"`);
    }
  });

  it('drops every deny-pattern line', () => {
    const input = [...ALLOW_LINES, ...DENY_LINES].join('\n');
    const out = filterLogs(input);
    for (const line of DENY_LINES) {
      assert.ok(!out.includes(line), `deny line leaked into output: "${line}"`);
    }
  });

  it('falls back to last 120 non-blank stripped lines when filter result is empty', () => {
    // Build an input that's ONLY deny-pattern lines + blanks, plus a unique
    // tail marker the fallback should preserve.
    const denyOnly = Array.from({ length: 150 }, (_, i) => `##[group]Setup step ${i}`);
    const tailMarker = 'UNIQUE-FALLBACK-TAIL-MARKER';
    denyOnly.push(tailMarker);
    const input = denyOnly.join('\n');
    const out = filterLogs(input);
    assert.ok(out.length > 0, 'fallback must return non-empty output');
    assert.ok(
      out.includes(tailMarker),
      'fallback must preserve the trailing line (last 120 non-blank)'
    );
  });

  it('keeps case-insensitive matches (Error: AND error:)', () => {
    const input = ['Error: boom', 'error: lowercase boom'].join('\n');
    const out = filterLogs(input);
    assert.ok(out.includes('Error: boom'));
    assert.ok(out.includes('error: lowercase boom'));
  });

  it('strips gh log prefix before predicate runs', () => {
    // gh log format: "JobName\tStepName\t<ISO timestamp> <message>"
    const prefixed = 'shard-2\tRun tests\t2026-05-12T10:14:53.123Z AssertionError: boom';
    const out = filterLogs(prefixed);
    assert.ok(out.includes('AssertionError: boom'));
    assert.ok(!out.includes('shard-2'), 'job name must be stripped');
  });
});

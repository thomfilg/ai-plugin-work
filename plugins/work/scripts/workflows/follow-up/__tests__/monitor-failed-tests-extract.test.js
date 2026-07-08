'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const monitor = require('../lib/steps/monitor');
const { extractFailedTestPaths } = monitor.__test__;

describe('extractFailedTestPaths', () => {
  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(extractFailedTestPaths(''), []);
    assert.deepEqual(extractFailedTestPaths(null), []);
    assert.deepEqual(extractFailedTestPaths(undefined), []);
    assert.deepEqual(extractFailedTestPaths(42), []);
  });

  it('extracts vitest-style FAIL lines with .test.ts paths', () => {
    const log = [
      'RUN  v1.0',
      ' FAIL  src/components/Button.test.tsx',
      ' FAIL  packages/core/src/parse.test.ts',
      ' PASS  src/ok.test.ts',
    ].join('\n');
    const out = extractFailedTestPaths(log);
    assert.ok(out.includes('src/components/Button.test.tsx'));
    assert.ok(out.includes('packages/core/src/parse.test.ts'));
    assert.ok(!out.includes('src/ok.test.ts'));
  });

  it('extracts jest-style FAIL lines', () => {
    const log = [
      'FAIL apps/web/src/utils/format.test.js',
      'FAIL plugins/work/scripts/foo.spec.js  (12.5 s)',
    ].join('\n');
    const out = extractFailedTestPaths(log);
    assert.ok(out.includes('apps/web/src/utils/format.test.js'));
    assert.ok(out.includes('plugins/work/scripts/foo.spec.js'));
  });

  it('extracts playwright-style failures with × marker and .spec.ts', () => {
    const log = [
      '  ×  tests/e2e/login.spec.ts:42:5 › login flow › redirects',
      '  ✘  packages/ui/tests/button.spec.ts:10:1 › renders',
    ].join('\n');
    const out = extractFailedTestPaths(log);
    assert.ok(out.includes('tests/e2e/login.spec.ts'));
    assert.ok(out.includes('packages/ui/tests/button.spec.ts'));
  });

  it('dedupes repeated paths', () => {
    const log = ['FAIL src/a.test.ts', 'FAIL src/a.test.ts', ' × src/a.test.ts:1:1 › x'].join('\n');
    const out = extractFailedTestPaths(log);
    assert.equal(out.filter((p) => p === 'src/a.test.ts').length, 1);
  });

  it('ignores noise lines that mention "fail" but no test path', () => {
    const log = ['Error: tests failed in CI', 'some random fail noise here'].join('\n');
    const out = extractFailedTestPaths(log);
    assert.deepEqual(out, []);
  });

  it('keeps paths relative (does not invent absolute paths)', () => {
    const log = 'FAIL plugins/work/scripts/workflows/follow-up/foo.test.js';
    const out = extractFailedTestPaths(log);
    assert.ok(out.every((p) => !p.startsWith('/')));
  });
});

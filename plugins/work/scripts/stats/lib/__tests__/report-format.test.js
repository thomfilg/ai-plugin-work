/**
 * Tests for the shared report renderer (GH-317 / Task 1 / R10).
 *
 * Scenarios covered:
 *   - 1.1 Status-line renderer: [PASS]/[WARN]/[FAIL]/[SKIP] prefixes + `label — detail` join
 *   - 1.2 Indented-metric renderer: two-space `Key: value` lines + `n/a` passthrough
 *
 * Run with:
 *   node --test scripts/stats/lib/__tests__/report-format.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let reportFormat;
try {
  reportFormat = require('../report-format');
} catch (_err) {
  // Module not implemented yet (RED phase): expose an empty surface so tests
  // collect and fail on behavior assertions rather than a load-time error.
  reportFormat = {};
}

describe('report-format — status-line renderer (1.1, R10)', () => {
  it('exports statusLine as a named function', () => {
    assert.equal(
      typeof reportFormat.statusLine,
      'function',
      'statusLine must be a named export of report-format.js',
    );
  });

  it('renders a [PASS] line with the bracketed prefix and label — detail join', () => {
    const line = reportFormat.statusLine({
      status: 'PASS',
      label: 'Hooks registered',
      detail: '7/7',
    });
    assert.equal(line, '[PASS] Hooks registered — 7/7');
  });

  it('renders a [WARN] line with the bracketed prefix', () => {
    const line = reportFormat.statusLine({
      status: 'WARN',
      label: 'Orphaned task dir',
      detail: 'GH-200',
    });
    assert.equal(line, '[WARN] Orphaned task dir — GH-200');
  });

  it('renders a [FAIL] line with the bracketed prefix', () => {
    const line = reportFormat.statusLine({
      status: 'FAIL',
      label: 'Invalid state',
      detail: 'missing startTime',
    });
    assert.equal(line, '[FAIL] Invalid state — missing startTime');
  });

  it('renders a [SKIP] line with the bracketed prefix', () => {
    const line = reportFormat.statusLine({
      status: 'SKIP',
      label: 'Config validation',
      detail: 'requires GH-310',
    });
    assert.equal(line, '[SKIP] Config validation — requires GH-310');
  });

  it('omits the " — detail" join when no detail is provided', () => {
    const line = reportFormat.statusLine({ status: 'PASS', label: 'All good' });
    assert.equal(line, '[PASS] All good');
  });

  it('handles each status case independently with its own prefix', () => {
    const statuses = ['PASS', 'WARN', 'FAIL', 'SKIP'];
    for (const status of statuses) {
      const line = reportFormat.statusLine({ status, label: 'x', detail: 'y' });
      assert.ok(
        line.startsWith(`[${status}]`),
        `expected line to start with [${status}], got: ${line}`,
      );
    }
  });

  it('throws (or falls back deterministically) on an unknown status', () => {
    let threw = false;
    let fallback;
    try {
      fallback = reportFormat.statusLine({ status: 'BOGUS', label: 'x', detail: 'y' });
    } catch (_err) {
      threw = true;
    }
    if (!threw) {
      // If it does not throw, it must fall back deterministically (not emit "[BOGUS]").
      assert.ok(
        !fallback.includes('[BOGUS]'),
        'unknown status must not leak through as a bracketed prefix',
      );
    }
    assert.ok(threw || typeof fallback === 'string');
  });
});

describe('report-format — indented-metric renderer (1.2, R10)', () => {
  it('exports metricBlock as a named function', () => {
    assert.equal(
      typeof reportFormat.metricBlock,
      'function',
      'metricBlock must be a named export of report-format.js',
    );
  });

  it('renders metric pairs as two-space-indented `Key: value` lines', () => {
    const out = reportFormat.metricBlock([
      ['Step', 'implement (9/19)'],
      ['Retries', '2 (check→implement loop)'],
    ]);
    assert.equal(
      out,
      '  Step: implement (9/19)\n  Retries: 2 (check→implement loop)',
    );
  });

  it('renders an `n/a` value verbatim as `n/a`', () => {
    const out = reportFormat.metricBlock([['Duration', 'n/a']]);
    assert.equal(out, '  Duration: n/a');
  });

  it('indents every line with exactly two leading spaces', () => {
    const out = reportFormat.metricBlock([
      ['A', '1'],
      ['B', '2'],
      ['C', '3'],
    ]);
    for (const line of out.split('\n')) {
      assert.ok(line.startsWith('  '), `line not two-space indented: ${JSON.stringify(line)}`);
      assert.ok(!line.startsWith('   '), `line over-indented: ${JSON.stringify(line)}`);
    }
  });

  it('returns an empty string for an empty metric list', () => {
    assert.equal(reportFormat.metricBlock([]), '');
  });
});

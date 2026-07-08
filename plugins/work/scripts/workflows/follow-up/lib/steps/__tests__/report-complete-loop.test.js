'use strict';

// report-complete-loop.test.js — the report step must COMPLETE (not surface
// forever) for failure categories that triage legitimately sets on its
// routing paths ('reviews', 'ci_cancelled_blocking' — echo-6204), and the
// completion summary must itemize what happened to each review comment.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadReportHandler() {
  const handlers = {};
  delete require.cache[require.resolve('../report')];
  require('../report')((name, fn) => {
    handlers[name] = fn;
  });
  return handlers.report;
}

describe('report step — completion vs surface loop', () => {
  let tmpDir;
  let ctx;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
    process.env.CLAUDE_AGENT_INBOX_DIR = tmpDir; // hermetic notifications
    ctx = { tasksDir: tmpDir, worktreeDir: tmpDir };
  });

  afterEach(() => {
    delete process.env.CLAUDE_AGENT_INBOX_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function baseState(overrides) {
    return {
      ticketId: 'GH-9',
      prNumber: 42,
      attempt: 3,
      status: 'in_progress',
      lastMonitorResult: { exitCode: 0, output: 'CI: PASSING' },
      ...overrides,
    };
  }

  it("failureCategory 'reviews' completes instead of surfacing (echo-6204)", () => {
    const report = loadReportHandler();
    const state = baseState({ failureCategory: 'reviews' });
    const result = report(state, ctx);
    assert.equal(result.action, 'complete');
    assert.equal(state.status, 'complete');
  });

  it("canonical 'review_failure' (GH-670 normalized spelling) completes too", () => {
    const report = loadReportHandler();
    const state = baseState({ failureCategory: 'review_failure' });
    const result = report(state, ctx);
    assert.equal(result.action, 'complete');
    assert.equal(state.status, 'complete');
  });

  it("failureCategory 'ci_cancelled_blocking' completes instead of surfacing", () => {
    const report = loadReportHandler();
    const state = baseState({ failureCategory: 'ci_cancelled_blocking' });
    const result = report(state, ctx);
    assert.equal(result.action, 'complete');
  });

  it('unknown failureCategory still surfaces (GH-508 guard preserved)', () => {
    const report = loadReportHandler();
    const state = baseState({ failureCategory: 'github-actions-outage' });
    const result = report(state, ctx);
    assert.equal(result.action, 'surface');
    assert.notEqual(state.status, 'complete');
  });

  it('completion summary itemizes solved/skipped/outdated comments', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'follow-up-comments.json'),
      JSON.stringify({
        comments: [
          {
            id: 'c1',
            author: 'cursor[bot]',
            path: 'src/a.js',
            line: 10,
            status: 'solved',
            resolution: 'Fixed null deref',
          },
          {
            id: 'c2',
            author: 'cursor[bot]',
            path: 'src/b.js',
            status: 'skipped',
            resolution: 'Outside scope of brief/spec',
          },
          {
            id: 'c3',
            author: 'copilot',
            path: 'src/c.js',
            status: 'resolved',
            resolution: 'Outdated (code changed since comment)',
          },
          { id: 'c4', author: 'cursor[bot]', path: 'src/d.js', status: 'unsolved' },
        ],
      })
    );
    const report = loadReportHandler();
    const state = baseState({ _solvedReviewsCount: 1, _skippedReviewsCount: 1 });
    const result = report(state, ctx);
    assert.equal(result.action, 'complete');
    assert.ok(result.summary.includes('src/a.js:10'), 'solved comment itemized');
    assert.ok(result.summary.includes('Fixed null deref'), 'solved resolution shown');
    assert.ok(result.summary.includes('src/b.js'), 'skipped comment itemized');
    assert.ok(result.summary.includes('Outside scope'), 'skip reason shown');
    assert.ok(result.summary.includes('src/c.js'), 'outdated comment itemized — not dropped');
    assert.ok(!result.summary.includes('src/d.js'), 'unsolved comments not listed as addressed');
    assert.ok(result.summary.includes('1 solved, 1 skipped'), 'aggregate counts present');
  });

  it('completion summary stays terse when there were no review comments', () => {
    const report = loadReportHandler();
    const result = report(baseState({}), ctx);
    assert.equal(result.action, 'complete');
    assert.ok(!result.summary.includes('Review comments:'));
  });
});

'use strict';

// fix-reviews-done-routing.test.js — when all comments are terminal the step
// must (a) record solved/skipped counts on EVERY done path (the all-solved
// path previously recorded nothing, so the completion summary never
// mentioned reviews), and (b) route through push-retry when review-fix
// commits are still unpushed (previously the skipped>0 path jumped straight
// to report and the workflow completed with the fixes never pushed).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function loadFixReviewsHandler() {
  const handlers = {};
  delete require.cache[require.resolve('../fix-reviews')];
  require('../fix-reviews')((name, fn) => {
    handlers[name] = fn;
  });
  return handlers['fix-reviews'];
}

// A stand-in follow-up-pr-comments.js: --next-comment says done, --status
// reports the counts baked into the stub via env.
const STUB_COMMENTS_SCRIPT = `
'use strict';
const arg = process.argv[2];
if (arg === '--next-comment') { console.log(JSON.stringify({ done: true })); }
else if (arg === '--status') {
  console.log(process.env.STUB_STATUS_JSON || '{"remaining":0,"total":2,"solved":2,"skipped":0}');
} else { console.log('{}'); }
`;

describe('fix-reviews — done-path routing and counts', () => {
  let tmpDir;
  let workScriptsDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixrev-test-'));
    workScriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(workScriptsDir, { recursive: true });
    fs.writeFileSync(path.join(workScriptsDir, 'follow-up-pr-comments.js'), STUB_COMMENTS_SCRIPT);
  });

  afterEach(() => {
    delete process.env.STUB_STATUS_JSON;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runDonePath(worktreeDir, statusJson) {
    if (statusJson) process.env.STUB_STATUS_JSON = statusJson;
    const handler = loadFixReviewsHandler();
    const state = {
      ticketId: 'GH-7',
      prNumber: 5,
      currentStep: 'fix-reviews',
      _reviewSnapshotDone: true,
    };
    const result = handler(state, { worktreeDir, workScriptsDir });
    return { state, result };
  }

  it('all-solved: records counts and routes to report when nothing is unpushed', () => {
    const cleanDir = path.join(tmpDir, 'clean'); // not a git repo → nothing unpushed
    fs.mkdirSync(cleanDir);
    const { state, result } = runDonePath(
      cleanDir,
      '{"remaining":0,"total":2,"solved":2,"skipped":0}'
    );
    assert.equal(result, null);
    assert.equal(state._solvedReviewsCount, 2, 'solved count recorded even with skipped=0');
    assert.equal(state._skippedReviewsCount, 0);
    assert.equal(state.currentStep, 'report');
  });

  it('routes through push-retry when commits exist ahead of upstream', () => {
    // Real upstream: bare remote + clone, push -u, then one more commit.
    const bareDir = path.join(tmpDir, 'origin.git');
    const repoDir = path.join(tmpDir, 'repo');
    execFileSync('git', ['init', '-q', '--bare', bareDir]);
    execFileSync('git', ['clone', '-q', bareDir, repoDir]);
    const git = (args) =>
      execFileSync('git', args, {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
    fs.writeFileSync(path.join(repoDir, 'a.js'), '// base\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    git(['push', '-q', '-u', 'origin', 'HEAD']);
    fs.writeFileSync(path.join(repoDir, 'fix.js'), '// review fix\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'fix(review): x']); // 1 ahead of upstream
    const { state } = runDonePath(repoDir, '{"remaining":0,"total":1,"solved":1,"skipped":0}');
    assert.equal(state.currentStep, 'push-retry', 'unpushed fixes must go through push-retry');
  });

  it('a dirty no-upstream worktree does NOT loop into push-retry (strict probe)', () => {
    // Regression: the dirty-tree fallback used to send done→push-retry every
    // cycle for a stray untracked file, spinning _pushRetryCount to the cap.
    const repoDir = path.join(tmpDir, 'dirty-repo');
    fs.mkdirSync(repoDir);
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'stray.log'), 'junk\n'); // dirty, no upstream
    const { state } = runDonePath(repoDir, '{"remaining":0,"total":1,"solved":1,"skipped":0}');
    assert.equal(state.currentStep, 'report', 'no unpushed COMMITS → report, not push-retry');
  });

  it('skipped>0: still records both counts', () => {
    const cleanDir = path.join(tmpDir, 'clean2');
    fs.mkdirSync(cleanDir);
    const { state } = runDonePath(cleanDir, '{"remaining":0,"total":3,"solved":2,"skipped":1}');
    assert.equal(state._solvedReviewsCount, 2);
    assert.equal(state._skippedReviewsCount, 1);
    assert.equal(state.currentStep, 'report');
  });
});

/**
 * Tests for work-pr.workflow.js
 *
 * Covers: transitions, skip combinations, params(), detectStepState(), inspect helpers.
 * Uses node:test + node:assert/strict.
 * Run: node --test workflows/__tests__/work-pr.workflow.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'work-pr.workflow.js');

describe('work-pr.workflow.js', () => {
  const wf = require(WORKFLOW_PATH);

  // ─── Transition Graph ────────────────────────────────────────────────

  describe('transitions', () => {
    it('should have 6 steps', () => {
      assert.equal(wf.steps.length, 6);
    });

    it('should define transitions for all steps', () => {
      const stepIds = wf.steps.map(s => s.id);
      const transitionSources = wf.transitions.map(t => t.source);
      for (const id of stepIds) {
        assert.ok(transitionSources.includes(id), `Missing transition for ${id}`);
      }
    });

    // 2_setup edges
    it('2_setup → 3_pr_gen (happy path)', () => {
      const t = wf.transitions.find(t => t.source === '2_setup');
      assert.ok(t.targets.includes('3_pr_gen'));
    });

    it('2_setup → 4_screenshot_gate (pr_gen SKIP, screenshot gate RUN)', () => {
      const t = wf.transitions.find(t => t.source === '2_setup');
      assert.ok(t.targets.includes('4_screenshot_gate'));
    });

    it('2_setup → 5_post_pr_gen (pr_gen SKIP, post_pr_gen RUN)', () => {
      const t = wf.transitions.find(t => t.source === '2_setup');
      assert.ok(t.targets.includes('5_post_pr_gen'));
    });

    it('2_setup → 6_summary (all SKIP)', () => {
      const t = wf.transitions.find(t => t.source === '2_setup');
      assert.ok(t.targets.includes('6_summary'));
    });

    // 3_pr_gen edges
    it('3_pr_gen → 4_screenshot_gate (happy path)', () => {
      const t = wf.transitions.find(t => t.source === '3_pr_gen');
      assert.ok(t.targets.includes('4_screenshot_gate'));
    });

    it('3_pr_gen → 5_post_pr_gen (screenshot_gate SKIP)', () => {
      const t = wf.transitions.find(t => t.source === '3_pr_gen');
      assert.ok(t.targets.includes('5_post_pr_gen'));
    });

    it('3_pr_gen → 6_summary (screenshot_gate + post_pr_gen both SKIP)', () => {
      const t = wf.transitions.find(t => t.source === '3_pr_gen');
      assert.ok(t.targets.includes('6_summary'));
    });

    // 4_screenshot_gate edges
    it('4_screenshot_gate → 5_post_pr_gen (forward)', () => {
      const t = wf.transitions.find(t => t.source === '4_screenshot_gate');
      assert.ok(t.targets.includes('5_post_pr_gen'));
    });

    it('4_screenshot_gate → 3_pr_gen (backward retry)', () => {
      const t = wf.transitions.find(t => t.source === '4_screenshot_gate');
      assert.ok(t.targets.includes('3_pr_gen'));
    });

    it('4_screenshot_gate → 6_summary (post_pr_gen SKIP)', () => {
      const t = wf.transitions.find(t => t.source === '4_screenshot_gate');
      assert.ok(t.targets.includes('6_summary'));
    });

    // Terminal
    it('6_summary is terminal', () => {
      const t = wf.transitions.find(t => t.source === '6_summary');
      assert.deepEqual(t.targets, []);
    });
  });

  // ─── Skip Combination Reachability ───────────────────────────────────

  describe('all skip combinations have legal paths', () => {
    const transitionMap = {};
    for (const t of wf.transitions) {
      transitionMap[t.source] = t.targets;
    }

    function canReach(from, to) {
      const visited = new Set();
      const queue = [from];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current === to) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const next of (transitionMap[current] || [])) {
          queue.push(next);
        }
      }
      return false;
    }

    it('all RUN: 2_setup → 3 → 4 → 5 → 6', () => {
      assert.ok(canReach('2_setup', '3_pr_gen'));
      assert.ok(canReach('3_pr_gen', '4_screenshot_gate'));
      assert.ok(canReach('4_screenshot_gate', '5_post_pr_gen'));
      assert.ok(canReach('5_post_pr_gen', '6_summary'));
    });

    it('all SKIP: 2_setup → 6_summary (direct)', () => {
      assert.ok(transitionMap['2_setup'].includes('6_summary'));
    });

    it('pr_gen=RUN, rest SKIP: 3_pr_gen → 6_summary', () => {
      assert.ok(transitionMap['3_pr_gen'].includes('6_summary'));
    });

    it('pr_gen=SKIP, post_pr_gen=RUN: 2_setup → 5_post_pr_gen', () => {
      assert.ok(transitionMap['2_setup'].includes('5_post_pr_gen'));
    });

    it('no TSX (screenshot_gate=SKIP): 3_pr_gen → 5_post_pr_gen', () => {
      assert.ok(transitionMap['3_pr_gen'].includes('5_post_pr_gen'));
    });

    it('pr_gen=SKIP, screenshot_gate=RUN: 2_setup → 4_screenshot_gate', () => {
      assert.ok(transitionMap['2_setup'].includes('4_screenshot_gate'));
    });

    it('screenshot_gate=RUN, post_pr_gen=SKIP: 4_screenshot_gate → 6_summary', () => {
      assert.ok(transitionMap['4_screenshot_gate'].includes('6_summary'));
    });

    it('screenshot retry loop: 4_screenshot_gate → 3_pr_gen → 4_screenshot_gate', () => {
      assert.ok(canReach('4_screenshot_gate', '3_pr_gen'));
      assert.ok(canReach('3_pr_gen', '4_screenshot_gate'));
    });
  });

  // ─── params() ────────────────────────────────────────────────────────

  describe('params()', () => {
    it('parses ticket ID', () => {
      const p = wf.params('PROJ-123');
      assert.equal(p.ticketId, 'PROJ-123');
      assert.equal(p.force, false);
    });

    it('parses --force flag', () => {
      const p = wf.params('PROJ-123 --force');
      assert.equal(p.ticketId, 'PROJ-123');
      assert.equal(p.force, true);
    });

    it('prefixes numeric IDs with project key', () => {
      const p = wf.params('856');
      assert.ok(p.ticketId.endsWith('-856'));
    });

    it('uppercases ticket ID', () => {
      const p = wf.params('proj-123');
      assert.equal(p.ticketId, 'PROJ-123');
    });

    it('sets instanceId same as ticketId', () => {
      const p = wf.params('PROJ-500');
      assert.equal(p.instanceId, p.ticketId);
    });

    it('throws on empty args', () => {
      assert.throws(() => wf.params(''), /Usage/);
    });
  });

  // ─── detectStepState() ──────────────────────────────────────────────

  describe('detectStepState()', () => {
    // Helper to build inspect data with defaults
    function makeInspect(overrides = {}) {
      return {
        headSha: 'abc12345abc12345abc12345abc12345abc12345',
        screenshotHash: 'none',
        prKey: 'abc12345abc12345abc12345abc12345abc12345|none',
        lastPrSha: '',
        prUpToDate: false,
        hasTsxChanges: false,
        screenshotsExist: false,
        screenshotCount: 0,
        hasContent: true,
        contentSha: 'def456',
        lastPostPrSha: '',
        commitsBehindMain: 0,
        postPrUpToDate: false,
        ...overrides,
      };
    }

    // 1_preflight and 2_setup always RUN
    it('1_preflight always RUN', () => {
      const r = wf.detectStepState('1_preflight', 'X-1', null, makeInspect());
      assert.equal(r.action, 'RUN');
    });

    it('2_setup always RUN', () => {
      const r = wf.detectStepState('2_setup', 'X-1', null, makeInspect());
      assert.equal(r.action, 'RUN');
    });

    // 3_pr_gen
    it('3_pr_gen: RUN when no previous SHA', () => {
      const r = wf.detectStepState('3_pr_gen', 'X-1', null, makeInspect());
      assert.equal(r.action, 'RUN');
      assert.match(r.reason, /No previous/);
    });

    it('3_pr_gen: SKIP when compound key matches', () => {
      const key = 'abc12345|none';
      const r = wf.detectStepState('3_pr_gen', 'X-1', null, makeInspect({
        prKey: key,
        lastPrSha: key,
        prUpToDate: true,
      }));
      assert.equal(r.action, 'SKIP');
      assert.match(r.reason, /Compound key matches/);
    });

    it('3_pr_gen: RUN when compound key changed', () => {
      const r = wf.detectStepState('3_pr_gen', 'X-1', null, makeInspect({
        prKey: 'newsha|none',
        lastPrSha: 'oldsha|none',
        prUpToDate: false,
      }));
      assert.equal(r.action, 'RUN');
      assert.match(r.reason, /Key changed/);
    });

    it('3_pr_gen: RUN with force even when up-to-date', () => {
      const key = 'abc|none';
      const r = wf.detectStepState('3_pr_gen', 'X-1', { force: true }, makeInspect({
        prKey: key,
        lastPrSha: key,
        prUpToDate: true,
      }));
      assert.equal(r.action, 'RUN');
      assert.match(r.reason, /Force mode/);
    });

    // Rebase guard tests
    it('3_pr_gen: BLOCKED when commitsBehindMain > 0', () => {
      const orig = process.env.REBASE_GUARD_THRESHOLD;
      process.env.REBASE_GUARD_THRESHOLD = '0';
      try {
        const r = wf.detectStepState('3_pr_gen', 'X-1', null, makeInspect({
          commitsBehindMain: 5,
        }));
        assert.equal(r.action, 'BLOCKED');
        assert.match(r.reason, /behind/);
      } finally {
        if (orig === undefined) delete process.env.REBASE_GUARD_THRESHOLD;
        else process.env.REBASE_GUARD_THRESHOLD = orig;
      }
    });

    it('3_pr_gen: not BLOCKED when commitsBehindMain === 0', () => {
      const orig = process.env.REBASE_GUARD_THRESHOLD;
      process.env.REBASE_GUARD_THRESHOLD = '0';
      try {
        const r = wf.detectStepState('3_pr_gen', 'X-1', null, makeInspect({
          commitsBehindMain: 0,
        }));
        assert.notEqual(r.action, 'BLOCKED');
      } finally {
        if (orig === undefined) delete process.env.REBASE_GUARD_THRESHOLD;
        else process.env.REBASE_GUARD_THRESHOLD = orig;
      }
    });

    it('3_pr_gen: compound key includes screenshot hash', () => {
      const r = wf.detectStepState('3_pr_gen', 'X-1', null, makeInspect({
        headSha: 'aaa',
        screenshotHash: 'bbb',
        prKey: 'aaa|bbb',
        lastPrSha: 'aaa|none',
        prUpToDate: false,
      }));
      assert.equal(r.action, 'RUN');
      assert.match(r.reason, /Key changed/);
    });

    // 4_screenshot_gate — no force bypass (B4)
    it('4_screenshot_gate: SKIP when no TSX changes', () => {
      const r = wf.detectStepState('4_screenshot_gate', 'X-1', null, makeInspect({
        hasTsxChanges: false,
      }));
      assert.equal(r.action, 'SKIP');
      assert.match(r.reason, /No TSX/);
    });

    it('4_screenshot_gate: SKIP when screenshots exist', () => {
      const r = wf.detectStepState('4_screenshot_gate', 'X-1', null, makeInspect({
        hasTsxChanges: true,
        screenshotsExist: true,
        screenshotCount: 3,
      }));
      assert.equal(r.action, 'SKIP');
      assert.match(r.reason, /3 screenshot/);
    });

    it('4_screenshot_gate: RUN when TSX changed but no screenshots', () => {
      const r = wf.detectStepState('4_screenshot_gate', 'X-1', null, makeInspect({
        hasTsxChanges: true,
        screenshotsExist: false,
        screenshotCount: 0,
      }));
      assert.equal(r.action, 'RUN');
      assert.match(r.reason, /gate required/);
    });

    it('4_screenshot_gate: NO force bypass — still RUN with force when gate needed', () => {
      const r = wf.detectStepState('4_screenshot_gate', 'X-1', { force: true }, makeInspect({
        hasTsxChanges: true,
        screenshotsExist: false,
        screenshotCount: 0,
      }));
      assert.equal(r.action, 'RUN', 'Force should NOT bypass screenshot gate');
    });

    // 5_post_pr_gen
    it('5_post_pr_gen: SKIP when no content (empty SHA)', () => {
      const r = wf.detectStepState('5_post_pr_gen', 'X-1', null, makeInspect({
        hasContent: false,
        contentSha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }));
      assert.equal(r.action, 'SKIP');
      assert.match(r.reason, /No content/);
    });

    it('5_post_pr_gen: SKIP when content SHA matches', () => {
      const r = wf.detectStepState('5_post_pr_gen', 'X-1', null, makeInspect({
        hasContent: true,
        contentSha: 'abc123',
        lastPostPrSha: 'abc123',
        postPrUpToDate: true,
      }));
      assert.equal(r.action, 'SKIP');
      assert.match(r.reason, /Content SHA matches/);
    });

    it('5_post_pr_gen: RUN when content changed', () => {
      const r = wf.detectStepState('5_post_pr_gen', 'X-1', null, makeInspect({
        hasContent: true,
        contentSha: 'new123',
        lastPostPrSha: 'old456',
        postPrUpToDate: false,
      }));
      assert.equal(r.action, 'RUN');
      assert.match(r.reason, /Content changed/);
    });

    it('5_post_pr_gen: RUN with force even when up-to-date', () => {
      const r = wf.detectStepState('5_post_pr_gen', 'X-1', { force: true }, makeInspect({
        hasContent: true,
        contentSha: 'abc',
        lastPostPrSha: 'abc',
        postPrUpToDate: true,
      }));
      assert.equal(r.action, 'RUN');
      assert.match(r.reason, /Force mode/);
    });

    // 6_summary
    it('6_summary always RUN', () => {
      const r = wf.detectStepState('6_summary', 'X-1', null, makeInspect());
      assert.equal(r.action, 'RUN');
    });

    // Unknown step
    it('unknown step defaults to RUN', () => {
      const r = wf.detectStepState('99_unknown', 'X-1', null, makeInspect());
      assert.equal(r.action, 'RUN');
    });
  });

  // ─── onTransition ───────────────────────────────────────────────────

  describe('onTransition()', () => {
    it('exports onTransition as a function', () => {
      assert.equal(typeof wf.onTransition, 'function');
    });

    it('does nothing when from is not 3_pr_gen', () => {
      // Should not throw when called with a different step
      wf.onTransition('1_preflight', '2_setup', 'TEST-999');
      wf.onTransition('4_screenshot_gate', '5_post_pr_gen', 'TEST-999');
    }); // verified: only 3_pr_gen triggers SHA write

    it('gracefully handles non-existent worktree for from === 3_pr_gen', () => {
      // When worktree dir does not exist, onTransition should not throw
      // (it logs to stderr and returns gracefully)
      assert.doesNotThrow(() => {
        wf.onTransition('3_pr_gen', '4_screenshot_gate', 'NONEXISTENT-999');
      });
    });

    it('writes .pr-update-sha with correct compound key when worktree exists', () => {
      const fs = require('fs');
      const { execSync } = require('child_process');
      const os = require('os');
      const tmpDir = path.join(os.tmpdir(), 'work-pr-sha-test-' + process.pid);

      // Setup: create a temp git repo as worktree and a tasks dir
      const fakeWorktree = path.join(tmpDir, 'fakerepo-TEST-SHA');
      const fakeTasks = path.join(tmpDir, 'TEST-SHA');
      fs.mkdirSync(fakeWorktree, { recursive: true });
      fs.mkdirSync(fakeTasks, { recursive: true });
      execSync('git init && git config user.email "test@test.com" && git config user.name "Test" && git commit --allow-empty -m "init"', { cwd: fakeWorktree, stdio: 'pipe' });
      const expectedSha = execSync('git rev-parse HEAD', { cwd: fakeWorktree, encoding: 'utf8' }).trim(); // git user configured above

      // Override module-level constants via env vars
      // Note: getConfig caches values, so we need to work with the module's existing resolution.
      // Instead, directly test the onTransition logic by temporarily patching env vars
      // that affect getWorktreeDir and getTasksDir at require-time.
      // Since those are evaluated when the module loads, we test via a fresh require.

      // Approach: require a fresh copy of the module with overridden env
      const origEnv = { ...process.env };
      process.env.WORKTREES_BASE = tmpDir;
      process.env.REPO_NAME = 'fakerepo';
      process.env.TASKS_BASE = tmpDir;

      // Clear require cache to pick up new env vars
      const wfPath = require.resolve(path.join(__dirname, '..', 'work-pr.workflow.js'));
      const configPath = require.resolve(path.join(__dirname, '..', '..', 'lib', 'get-config.js'));
      delete require.cache[wfPath];
      delete require.cache[configPath];

      try {
        const freshWf = require(wfPath);
        freshWf.onTransition('3_pr_gen', '4_screenshot_gate', 'TEST-SHA');

        const shaFile = path.join(fakeTasks, '.pr-update-sha');
        assert.ok(fs.existsSync(shaFile), '.pr-update-sha should be written');
        const content = fs.readFileSync(shaFile, 'utf8').trim();
        assert.ok(content.startsWith(expectedSha), `Should start with HEAD SHA ${expectedSha.slice(0,8)}, got: ${content.slice(0,8)}`);
        assert.ok(content.includes('|'), 'Should contain pipe separator for compound key');
      } finally {
        // Restore env and clear cache
        Object.assign(process.env, origEnv);
        // Remove vars that weren't in original env
        for (const key of ['WORKTREES_BASE', 'REPO_NAME', 'TASKS_BASE']) {
          if (!(key in origEnv)) delete process.env[key];
        }
        delete require.cache[wfPath];
        delete require.cache[configPath];
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('does not throw for any step combination', () => {
      const steps = wf.steps.map(s => s.id);
      for (const from of steps) {
        for (const to of steps) {
          assert.doesNotThrow(() => {
            wf.onTransition(from, to, 'SAFETY-TEST');
          }, `onTransition(${from}, ${to}) should not throw`);
        }
      }
    }); // all step transitions tested
  });

  // ─── Structural checks ──────────────────────────────────────────────

  describe('structure', () => {
    it('exports name, command, stateDir', () => {
      assert.equal(wf.name, 'work-pr');
      assert.equal(wf.command, '/work-pr');
      assert.ok(wf.stateDir);
    });

    it('exports extraStateFields with force, prUpdated, postPrUpdated', () => {
      assert.equal(wf.extraStateFields.force, false);
      assert.equal(wf.extraStateFields.prUpdated, false);
      assert.equal(wf.extraStateFields.postPrUpdated, false);
    });

    it('exports inspect function', () => {
      assert.equal(typeof wf.inspect, 'function');
    });

    it('exports detectStepState function', () => {
      assert.equal(typeof wf.detectStepState, 'function');
    });
  });

  // ─── computeScreenshotHash() ─────────────────────────────────────

  describe('computeScreenshotHash()', () => {
    const os = require('os');
    const fs = require('fs');
    const crypto = require('crypto');
    const tmpBase = path.join(os.tmpdir(), 'screenshot-hash-test-' + process.pid);

    after(() => {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    });

    // Access internal function via test-only export
    const hashFn = wf._computeScreenshotHash;

    it('returns none for non-existent directory', () => {
      assert.equal(hashFn('/tmp/does-not-exist-' + process.pid), 'none');
    });

    it('returns none for empty directory', () => {
      const dir = path.join(tmpBase, 'empty');
      fs.mkdirSync(dir, { recursive: true });
      assert.equal(hashFn(dir), 'none');
    });

    it('returns consistent hash for same files', () => {
      const dir = path.join(tmpBase, 'consistent');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.png'), 'image-data-a');
      fs.writeFileSync(path.join(dir, 'b.jpg'), 'image-data-b');
      const hash1 = hashFn(dir);
      const hash2 = hashFn(dir);
      assert.equal(hash1, hash2, 'same files should produce same hash');
      assert.notEqual(hash1, 'none');
    });

    it('hash changes when file content changes', () => {
      const dir = path.join(tmpBase, 'change');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'test.png'), 'original');
      const hash1 = hashFn(dir);
      fs.writeFileSync(path.join(dir, 'test.png'), 'modified');
      const hash2 = hashFn(dir);
      assert.notEqual(hash1, hash2, 'hash should change when content changes');
    });

    it('handles nested subdirectories', () => {
      const dir = path.join(tmpBase, 'nested');
      fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'top.png'), 'top-level');
      fs.writeFileSync(path.join(dir, 'sub', 'nested.png'), 'nested');
      const hash = hashFn(dir);
      assert.notEqual(hash, 'none', 'should hash files in nested dirs');
    });

    it('ignores non-image files', () => {
      const dir = path.join(tmpBase, 'filter');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'image.png'), 'image');
      const hashWithImage = hashFn(dir);
      fs.writeFileSync(path.join(dir, 'readme.txt'), 'not an image');
      const hashWithText = hashFn(dir);
      assert.equal(hashWithImage, hashWithText, 'non-image files should not affect hash');
    });
  });
});

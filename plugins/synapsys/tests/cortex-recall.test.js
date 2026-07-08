'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Load the module under test defensively. While the source does not yet
// exist (RED phase), every test fails on a plain assertion ("module not
// loadable") rather than letting a raw MODULE_NOT_FOUND stack escape — the
// latter reads as a structural/load failure, this reads as the genuine
// behavior gap the GREEN implementation must close.
function loadRecall() {
  let mod;
  try {
    mod = require('../lib/cortex-recall');
  } catch {
    mod = null;
  }
  assert.ok(mod, 'lib/cortex-recall module must be loadable and export its API');
  return mod;
}

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-recall-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function cacheFile(home, sessionId) {
  return path.join(home, '.claude', 'synapsys', '.cache', `${sessionId}.json`);
}

// ---------------------------------------------------------------------------
// 6.1 resolveProjectId(cwd, env) — override -> git remote -> cwd basename
// ---------------------------------------------------------------------------

test('resolveProjectId: SYNAPSYS_CORTEX_PROJECT override wins', () => {
  const { resolveProjectId } = loadRecall();
  const id = resolveProjectId('/work/claude-plugin-work-GH-519', {
    env: { SYNAPSYS_CORTEX_PROJECT: 'override-project' },
    exec: () => 'git@github.com:owner/some-other-repo.git',
  });
  assert.equal(id, 'override-project');
});

test('resolveProjectId: uses git remote basename minus .git (ssh url)', () => {
  const { resolveProjectId } = loadRecall();
  const id = resolveProjectId('/work/claude-plugin-work-GH-519', {
    env: {},
    exec: () => 'git@github.com:owner/claude-plugin-work.git',
  });
  assert.equal(id, 'claude-plugin-work');
});

test('resolveProjectId: uses git remote basename minus .git (https url)', () => {
  const { resolveProjectId } = loadRecall();
  const id = resolveProjectId('/work/anything', {
    env: {},
    exec: () => 'https://github.com/owner/claude-plugin-work.git\n',
  });
  assert.equal(id, 'claude-plugin-work');
});

test('resolveProjectId: falls back to cwd basename stripping worktree affixes', () => {
  const { resolveProjectId } = loadRecall();
  // exec throws -> no remote -> cwd basename fallback.
  const id = resolveProjectId('/work/w-claude-plugin-work-GH-519', {
    env: {},
    exec: () => {
      throw new Error('not a git repo');
    },
  });
  // `^w-` and `-GH-\d+$` are both stripped: w-claude-plugin-work-GH-519 -> claude-plugin-work
  assert.equal(id, 'claude-plugin-work');
});

test('resolveProjectId: cwd fallback strips a PROJ-style suffix', () => {
  const { resolveProjectId } = loadRecall();
  const id = resolveProjectId('/work/myrepo-PROJ-123', {
    env: {},
    exec: () => {
      throw new Error('no remote');
    },
  });
  assert.equal(id, 'myrepo');
});

// ---------------------------------------------------------------------------
// 6.2 deriveKeywords({ ticketId, cwd }) — no LLM call
// ---------------------------------------------------------------------------

test('deriveKeywords: uses gh issue title tokens for a GitHub ticket', () => {
  const { deriveKeywords } = loadRecall();
  const exec = (cmd) => {
    if (cmd.includes('gh issue view')) {
      return JSON.stringify({ title: 'Add cortex auto recall orchestrator' });
    }
    if (cmd.includes('git status')) return '';
    return '';
  };
  const kws = deriveKeywords({ ticketId: 'GH-519', cwd: '/work/repo' }, { exec, maxKeywords: 6 });
  assert.ok(kws.includes('cortex'), `expected cortex in ${JSON.stringify(kws)}`);
  assert.ok(kws.includes('orchestrator'), `expected orchestrator in ${JSON.stringify(kws)}`);
});

test('deriveKeywords: drops stopwords and lowercases', () => {
  const { deriveKeywords } = loadRecall();
  const exec = (cmd) => {
    if (cmd.includes('gh issue view')) {
      return JSON.stringify({ title: 'The Cortex AND a Recall' });
    }
    return '';
  };
  const kws = deriveKeywords({ ticketId: 'GH-1', cwd: '/work/repo' }, { exec, maxKeywords: 6 });
  assert.ok(!kws.includes('the'), 'stopword "the" dropped');
  assert.ok(!kws.includes('and'), 'stopword "and" dropped');
  assert.ok(!kws.includes('a'), 'stopword "a" dropped');
  assert.ok(kws.includes('cortex'), 'content token kept + lowercased');
  assert.ok(kws.includes('recall'), 'content token kept + lowercased');
});

test('deriveKeywords: augments with git status file stems', () => {
  const { deriveKeywords } = loadRecall();
  const exec = (cmd) => {
    if (cmd.includes('gh issue view')) {
      return JSON.stringify({ title: 'cortex feature' });
    }
    if (cmd.includes('git status')) {
      return ' M plugins/synapsys/lib/cortex-recall.js\n?? plugins/synapsys/tests/cortex-recall.test.js\n';
    }
    return '';
  };
  const kws = deriveKeywords({ ticketId: 'GH-1', cwd: '/work/repo' }, { exec, maxKeywords: 10 });
  assert.ok(kws.includes('cortex-recall'), `expected file stem in ${JSON.stringify(kws)}`);
});

test('deriveKeywords: dedupes repeated tokens', () => {
  const { deriveKeywords } = loadRecall();
  const exec = (cmd) => {
    if (cmd.includes('gh issue view')) {
      return JSON.stringify({ title: 'cortex cortex cortex recall' });
    }
    return '';
  };
  const kws = deriveKeywords({ ticketId: 'GH-1', cwd: '/work/repo' }, { exec, maxKeywords: 6 });
  const cortexCount = kws.filter((k) => k === 'cortex').length;
  assert.equal(cortexCount, 1, 'cortex appears exactly once');
});

test('deriveKeywords: caps the result at maxKeywords', () => {
  const { deriveKeywords } = loadRecall();
  const exec = (cmd) => {
    if (cmd.includes('gh issue view')) {
      return JSON.stringify({
        title: 'alpha bravo charlie delta echo foxtrot golf hotel',
      });
    }
    return '';
  };
  const kws = deriveKeywords({ ticketId: 'GH-1', cwd: '/work/repo' }, { exec, maxKeywords: 6 });
  assert.ok(kws.length <= 6, `expected <=6 keywords, got ${kws.length}`);
});

test('deriveKeywords: falls back to branch-name tokens when gh fails', () => {
  const { deriveKeywords } = loadRecall();
  const exec = (cmd) => {
    if (cmd.includes('gh issue view')) {
      throw new Error('gh not available');
    }
    if (cmd.includes('branch')) return 'feature/cortex-recall-orchestrator';
    return '';
  };
  const kws = deriveKeywords({ ticketId: 'GH-1', cwd: '/work/repo' }, { exec, maxKeywords: 6 });
  assert.ok(
    kws.includes('cortex') || kws.includes('recall') || kws.includes('orchestrator'),
    `expected a branch token in ${JSON.stringify(kws)}`
  );
});

// ---------------------------------------------------------------------------
// 6.3 shouldRun / scheduleRecall / consumeCache lifecycle
// ---------------------------------------------------------------------------

test('shouldRun: false when kill-switch env is on', () => {
  const { shouldRun } = loadRecall();
  const config = { enabled: true };
  assert.equal(shouldRun({ SYNAPSYS_CORTEX_AUTO_RECALL: 'off' }, config), false);
});

test('shouldRun: false when config.enabled is false', () => {
  const { shouldRun } = loadRecall();
  assert.equal(shouldRun({}, { enabled: false }), false);
});

test('shouldRun: true when enabled and kill-switch unset', () => {
  const { shouldRun } = loadRecall();
  assert.equal(shouldRun({}, { enabled: true }), true);
});

test('scheduleRecall: spawns at most two queries worth of work and never throws', () => {
  const { scheduleRecall } = loadRecall();
  const home = mkHome();
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  try {
    assert.doesNotThrow(() =>
      scheduleRecall({
        queries: ['GH-519', 'cortex recall', 'a third query that must be ignored'],
        projectId: 'claude-plugin-work',
        sessionId: 'sess-sched',
        home,
        spawn,
      })
    );
    assert.ok(calls.length >= 1, 'spawn should be invoked at least once');
    // The cost bound: only the `--query` flag values are forwarded, and there
    // are at most two of them regardless of how many queries were supplied.
    const passedQueries = calls.flatMap((c) => {
      const args = c.args || [];
      return args.filter((a, i) => args[i - 1] === '--query');
    });
    assert.ok(
      passedQueries.length <= 2,
      `at most two queries scheduled, got ${passedQueries.length}`
    );
    assert.ok(!passedQueries.includes('a third query that must be ignored'), 'third query dropped');
  } finally {
    cleanup(home);
  }
});

test('scheduleRecall: never throws when spawn itself fails (graceful degrade)', () => {
  const { scheduleRecall } = loadRecall();
  const home = mkHome();
  const spawn = () => {
    throw new Error('spawn ENOENT');
  };
  try {
    assert.doesNotThrow(() =>
      scheduleRecall({
        queries: ['GH-519', 'cortex recall'],
        projectId: 'p',
        sessionId: 'sess-fail',
        home,
        spawn,
      })
    );
  } finally {
    cleanup(home);
  }
});

test('consumeCache: formats the cached queries then deletes the cache file', () => {
  const { consumeCache } = loadRecall();
  const cache = require('../lib/session-cache');
  const home = mkHome();
  try {
    cache.write(
      'sess-consume',
      {
        queries: [
          {
            query: 'GH-519',
            projectId: 'claude-plugin-work',
            results: [
              {
                id: 'm1',
                savedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
                ageDays: 5,
                title: 'Stacked PR rebase',
                body: 'Rebase the stack onto main.',
              },
            ],
          },
        ],
      },
      { home }
    );

    const block = consumeCache('sess-consume', {
      home,
      config: { max_age_days: 180, max_chars_per_memory: 500 },
    });
    assert.ok(typeof block === 'string', 'returns a formatted string block');
    assert.ok(block.includes('[cortex:auto-recall]'), 'block has the header');
    assert.ok(block.includes('m1'), 'block includes the result id');
    assert.ok(!fs.existsSync(cacheFile(home, 'sess-consume')), 'cache file deleted after consume');
  } finally {
    cleanup(home);
  }
});

test('consumeCache: returns empty string and does not throw when no cache exists', () => {
  const { consumeCache } = loadRecall();
  const home = mkHome();
  try {
    let block;
    assert.doesNotThrow(() => {
      block = consumeCache('never', {
        home,
        config: { max_age_days: 180, max_chars_per_memory: 500 },
      });
    });
    assert.equal(block, '');
  } finally {
    cleanup(home);
  }
});

test('consumeCache: single-consume — a late background write after the first consume is NOT injected again', () => {
  const { consumeCache } = loadRecall();
  const cache = require('../lib/session-cache');
  const home = mkHome();
  const cfg = { max_age_days: 180, max_chars_per_memory: 500 };
  const record = {
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [
          { id: 'm1', savedAt: new Date().toISOString(), ageDays: 1, title: 'T', body: 'B' },
        ],
      },
    ],
  };
  try {
    // SessionStart baseline / first cache, first UserPromptSubmit consumes it.
    cache.write('sess-once', record, { home });
    const first = consumeCache('sess-once', { home, config: cfg });
    assert.ok(first.includes('[cortex:auto-recall]'), 'first consume injects the block');
    assert.ok(!fs.existsSync(cacheFile(home, 'sess-once')), 'cache deleted after first consume');

    // Detached background job finishes LATE and writes a fresh cache.
    cache.write('sess-once', record, { home });
    // The next prompt must NOT inject a second time (single-consume), and the
    // late cache must be cleaned up.
    const second = consumeCache('sess-once', { home, config: cfg });
    assert.equal(second, '', 'second consume returns empty — single-consume enforced');
    assert.ok(!fs.existsSync(cacheFile(home, 'sess-once')), 'late-written cache is dropped');
  } finally {
    cleanup(home);
  }
});

test('consumeCache: an empty/missing cache on the first consume still marks the session consumed (no late re-inject)', () => {
  const { consumeCache } = loadRecall();
  const cache = require('../lib/session-cache');
  const home = mkHome();
  const cfg = { max_age_days: 180, max_chars_per_memory: 500 };
  try {
    // First UserPromptSubmit: no cache yet (baseline missing / not ready). The
    // early-return path must STILL mark the session consumed.
    const first = consumeCache('sess-empty-first', { home, config: cfg });
    assert.equal(first, '', 'first consume of a missing cache returns empty');

    // Detached background job finishes LATE and writes real results.
    cache.write(
      'sess-empty-first',
      {
        queries: [
          {
            query: 'GH-519',
            projectId: 'claude-plugin-work',
            results: [
              { id: 'm1', savedAt: new Date().toISOString(), ageDays: 1, title: 'T', body: 'B' },
            ],
          },
        ],
      },
      { home }
    );

    // A later prompt must NOT inject — the first (empty) consume already burned
    // the single-consume budget.
    const second = consumeCache('sess-empty-first', { home, config: cfg });
    assert.equal(second, '', 'late background write is not injected after an empty first consume');
    assert.ok(!fs.existsSync(cacheFile(home, 'sess-empty-first')), 'late-written cache is dropped');
  } finally {
    cleanup(home);
  }
});

test('consumeCache: a baseline placeholder defers — a later real background write IS injected', () => {
  const { consumeCache } = loadRecall();
  const cache = require('../lib/session-cache');
  const home = mkHome();
  const cfg = { max_age_days: 180, max_chars_per_memory: 500 };
  try {
    // SessionStart writes the `baseline:true` placeholder (empty results) BEFORE
    // the detached job lands. A prompt arriving in this window must NOT consume
    // it (no "no matches" injection, no sentinel) so the real results survive.
    cache.write(
      'sess-baseline',
      {
        baseline: true,
        queries: [{ query: 'GH-519', projectId: 'claude-plugin-work', results: [] }],
      },
      { home }
    );
    const first = consumeCache('sess-baseline', { home, config: cfg });
    assert.equal(first, '', 'baseline placeholder is not consumed');
    assert.ok(
      fs.existsSync(cacheFile(home, 'sess-baseline')),
      'baseline cache is left in place for the real write'
    );

    // Detached background job finishes and overwrites with real results (no
    // baseline flag).
    cache.write(
      'sess-baseline',
      {
        queries: [
          {
            query: 'GH-519',
            projectId: 'claude-plugin-work',
            results: [
              { id: 'm1', savedAt: new Date().toISOString(), ageDays: 1, title: 'T', body: 'B' },
            ],
          },
        ],
      },
      { home }
    );

    // The next prompt now injects the real results exactly once.
    const second = consumeCache('sess-baseline', { home, config: cfg });
    assert.ok(
      second.includes('[cortex:auto-recall]'),
      'real results inject after the baseline defer'
    );
    assert.ok(
      !fs.existsSync(cacheFile(home, 'sess-baseline')),
      'cache deleted after the real consume'
    );

    // And single-consume still holds for any further late write.
    cache.write('sess-baseline', { queries: [] }, { home });
    const third = consumeCache('sess-baseline', { home, config: cfg });
    assert.equal(third, '', 'single-consume enforced after the real injection');
  } finally {
    cleanup(home);
  }
});

test('consumeCache: persists a READ-ONLY summary (query + count, no bodies) for the recall status surface', () => {
  const { consumeCache } = loadRecall();
  const cache = require('../lib/session-cache');
  const sentinel = require('../lib/consume-sentinel');
  const home = mkHome();
  const cfg = { max_age_days: 180, max_chars_per_memory: 500 };
  const record = {
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [
          { id: 'm1', savedAt: new Date().toISOString(), ageDays: 1, title: 'T', body: 'secret' },
          { id: 'm2', savedAt: new Date().toISOString(), ageDays: 1, title: 'T2', body: 'body2' },
        ],
      },
    ],
  };
  try {
    cache.write('sess-summary', record, { home });
    consumeCache('sess-summary', { home, config: cfg });

    const summary = sentinel.readSummary(cache, 'sess-summary', home);
    assert.ok(summary && summary.summary === true, 'summary record is persisted');
    assert.deepEqual(summary.queries, [{ query: 'GH-519', count: 2 }], 'query + count only');
    // The summary must NOT carry re-injectable result bodies.
    assert.equal(JSON.stringify(summary).includes('secret'), false, 'no result bodies leak');
  } finally {
    cleanup(home);
  }
});

test('markConsumed is atomic (TOCTOU): only the first caller claims Phase 1, the second loses', () => {
  const cache = require('../lib/session-cache');
  const sentinel = require('../lib/consume-sentinel');
  const home = mkHome();
  try {
    // Two concurrent first-prompt consumes both passed `isConsumed` (false) and
    // race to claim. The atomic create-or-fail guarantees exactly one wins, so
    // they can't both inject — closing the non-atomic check-then-act window.
    assert.equal(sentinel.markConsumed(cache, 'sess-race', home), true, 'first caller claims');
    assert.equal(sentinel.markConsumed(cache, 'sess-race', home), false, 'second caller loses');
  } finally {
    cleanup(home);
  }
});

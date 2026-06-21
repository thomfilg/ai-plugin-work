'use strict';

/**
 * Integration tests for Task 9 — cortex auto-recall wiring inside
 * `hooks/synapsys.js`.
 *
 * These drive the hook end-to-end as a detached CLI subprocess (exactly how
 * Claude Code invokes it), feeding a JSON payload on stdin and asserting the
 * stdout injection channel plus the on-disk session-cache side effects. No
 * model client, no live cortex MCP tool, and no real network are touched: the
 * Phase 2 inline recall is supplied through an injectable stub module and the
 * Phase 1 background recall degrades to empty results.
 *
 * Test-only seams the GREEN hook must honor (all fail-open / additive):
 *   - SYNAPSYS_CORTEX_TICKET / SYNAPSYS_CORTEX_PROJECT — deterministic id resolution
 *   - SYNAPSYS_CORTEX_KEYWORDS — forces the derived second-query string so the
 *     scheduling assertion does not depend on a live git working tree
 *   - SYNAPSYS_CORTEX_RECALL_MODULE — a module path exporting
 *     `recall(query, projectId)` used for the Phase 2 inline append; unset in
 *     production so the append is a graceful no-op
 *   - HOME — relocates the session cache root under a tmp dir
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'synapsys.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-recall-it-'));
}

function cleanup(dir) {
  // Detached background recall jobs may still be writing into the store when a
  // test reaches teardown, so a plain recursive rmSync can lose the rmdir/readdir
  // race and throw ENOTEMPTY (observed only under Node 20's timing). maxRetries
  // makes rmSync re-walk the tree until the writer settles.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function cacheFilePath(home, sessionId) {
  return path.join(home, '.claude', 'synapsys', '.cache', `${sessionId}.json`);
}

function seedCache(home, sessionId, record) {
  const dir = path.dirname(cacheFilePath(home, sessionId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cacheFilePath(home, sessionId), JSON.stringify(record));
}

/**
 * Run the hook for an event with a payload, isolated env, and a HOME override.
 * Returns the spawnSync result ({ status, stdout, stderr }).
 */
function runHook(event, payload, { home, env = {}, cwd } = {}) {
  return spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(payload || {}),
    encoding: 'utf8',
    cwd: cwd || (payload && payload.cwd) || os.tmpdir(),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...env,
    },
  });
}

/**
 * Poll (no sleep) for the detached background process to materialize the
 * session-cache file, then parse and return it. Returns null if it never
 * appears within the attempt budget.
 */
function waitForCache(home, sessionId, attempts = 200) {
  const file = cacheFilePath(home, sessionId);
  for (let i = 0; i < attempts; i += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // Busy-wait a bounded number of cheap fs reads; no timer / no sleep.
      for (let spin = 0; spin < 50000; spin += 1) {
        /* spin */
      }
    }
  }
  return null;
}

/** Write a ~/.claude/synapsys/config.yaml under the test HOME. */
function seedConfig(home, yaml) {
  const dir = path.join(home, '.claude', 'synapsys');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml, 'utf8');
}

/** Write a tmp module exporting a recall(query, projectId) stub. */
function writeRecallModule(home, body) {
  const file = path.join(home, 'fake-recall.js');
  fs.writeFileSync(file, body);
  return file;
}

/** Build a local synapsys store under cwd with a single memory file. */
function seedStore(cwd, fileName, contents) {
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), JSON.stringify({ kind: 'local' }));
  fs.writeFileSync(path.join(storeDir, fileName), contents);
  return storeDir;
}

// ===========================================================================
// Phase 1 — SessionStart scheduling + UserPromptSubmit injection/consume
// ===========================================================================

// Scenario: SessionStart fire-and-forget schedules two cortex_recall calls
test('SessionStart schedules two recall queries (ticket + derived keyword) with the resolved projectId', () => {
  const home = mkHome();
  const sessionId = `sess-${process.pid}-${Date.now()}`;
  try {
    const res = runHook(
      'SessionStart',
      { session_id: sessionId, cwd: home },
      {
        home,
        env: {
          SYNAPSYS_CORTEX_TICKET: 'GH-519',
          SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
          SYNAPSYS_CORTEX_KEYWORDS: 'maestro cortex recall',
          SYNAPSYS_NO_SETUP_HINT: '1',
        },
      }
    );

    assert.equal(res.status, 0, 'SessionStart must exit 0 without blocking');

    const record = waitForCache(home, sessionId);
    assert.ok(record, 'background recall must write a session-cache record');
    assert.ok(Array.isArray(record.queries), 'cache record has a queries array');
    assert.equal(record.queries.length, 2, 'exactly two queries scheduled (≤2 budget, R15)');

    const queryStrings = record.queries.map((q) => q.query);
    assert.ok(queryStrings.includes('GH-519'), 'first query is the ticket id "GH-519"');
    assert.ok(
      queryStrings.some((q) => q !== 'GH-519' && /maestro|cortex|recall/.test(q)),
      'second query is the derived-keyword query'
    );
    for (const q of record.queries) {
      assert.equal(q.projectId, 'claude-plugin-work', 'projectId resolved to the git-remote repo');
    }
  } finally {
    cleanup(home);
  }
});

// Scenario: Auto-recall results are injected at the next prompt boundary
test('UserPromptSubmit injects the [cortex:auto-recall] block once and consumes the cache', () => {
  const home = mkHome();
  const sessionId = `sess-${process.pid}-${Date.now()}-inject`;
  try {
    seedCache(home, sessionId, {
      queries: [
        {
          query: 'GH-519',
          projectId: 'claude-plugin-work',
          results: [
            {
              id: 'mem-abc',
              savedAt: new Date().toISOString(),
              title: 'stacked PR rebase note',
              body: 'Rebase the lower PR first, then restack the upper.',
              ageDays: 2,
            },
          ],
        },
      ],
    });

    const first = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'hello', cwd: home },
      {
        home,
        env: { SYNAPSYS_NO_SETUP_HINT: '1' },
      }
    );
    assert.equal(first.status, 0);
    assert.match(
      first.stdout,
      /\[cortex:auto-recall\]/,
      'stdout carries the auto-recall header block'
    );
    assert.match(first.stdout, /mem-abc/, 'result line shows the memory id');
    assert.match(first.stdout, /\d{4}-\d{2}-\d{2}/, 'result line shows the save date');

    assert.ok(
      !fs.existsSync(cacheFilePath(home, sessionId)),
      'the cache file is consumed (deleted) after injection'
    );

    const second = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'again', cwd: home },
      {
        home,
        env: { SYNAPSYS_NO_SETUP_HINT: '1' },
      }
    );
    assert.equal(second.status, 0);
    assert.ok(
      !/\[cortex:auto-recall\]/.test(second.stdout),
      'block is not re-injected on the next prompt (single-consume)'
    );
  } finally {
    cleanup(home);
  }
});

// Scenario: Empty result marker is emitted when cortex returns no matches
test('UserPromptSubmit renders "→ no matches" with no memory bodies when both queries are empty', () => {
  const home = mkHome();
  const sessionId = `sess-${process.pid}-${Date.now()}-empty`;
  try {
    seedCache(home, sessionId, {
      queries: [
        { query: 'GH-519', projectId: 'claude-plugin-work', results: [] },
        { query: 'maestro cortex', projectId: 'claude-plugin-work', results: [] },
      ],
    });

    const res = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'hi', cwd: home },
      {
        home,
        env: { SYNAPSYS_NO_SETUP_HINT: '1' },
      }
    );
    assert.equal(res.status, 0);
    assert.match(res.stdout, /→ no matches/, 'empty-result marker is present');
    assert.ok(!/saved \d{4}-\d{2}-\d{2}/.test(res.stdout), 'no memory bodies are injected');
  } finally {
    cleanup(home);
  }
});

// Scenario: Opt-out env var disables all auto-recall paths
test('SYNAPSYS_CORTEX_AUTO_RECALL=off schedules nothing and writes no cache on SessionStart', () => {
  const home = mkHome();
  const sessionId = `sess-${process.pid}-${Date.now()}-optout`;
  try {
    const res = runHook(
      'SessionStart',
      { session_id: sessionId, cwd: home },
      {
        home,
        env: {
          SYNAPSYS_CORTEX_AUTO_RECALL: 'off',
          SYNAPSYS_CORTEX_TICKET: 'GH-519',
          SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
          SYNAPSYS_CORTEX_KEYWORDS: 'maestro cortex recall',
          SYNAPSYS_NO_SETUP_HINT: '1',
        },
      }
    );
    assert.equal(res.status, 0);

    // Give any (erroneously) scheduled background job a bounded window to write.
    const record = waitForCache(home, sessionId, 30);
    assert.equal(record, null, 'no cache file is written under the opt-out kill-switch');
  } finally {
    cleanup(home);
  }
});

// Scenario: config sub-switch on_session_start:false disables the SessionStart path
test('on_session_start:false schedules nothing and writes no cache on SessionStart', () => {
  const home = mkHome();
  const sessionId = `sess-${process.pid}-${Date.now()}-noss`;
  try {
    seedConfig(home, 'cortex_auto_recall:\n  on_session_start: false\n');
    const res = runHook(
      'SessionStart',
      { session_id: sessionId, cwd: home },
      {
        home,
        env: {
          SYNAPSYS_CORTEX_TICKET: 'GH-519',
          SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
          SYNAPSYS_CORTEX_KEYWORDS: 'maestro cortex recall',
          SYNAPSYS_NO_SETUP_HINT: '1',
        },
      }
    );
    assert.equal(res.status, 0);

    // No baseline cache is written and no background job materializes one.
    const record = waitForCache(home, sessionId, 30);
    assert.equal(record, null, 'no cache file under on_session_start:false');
  } finally {
    cleanup(home);
  }
});

// Scenario: config sub-switch on_memory_fire:false disables the Phase 2 append
test('on_memory_fire:false leaves a fired memory body unchanged (no cortex_query append)', () => {
  const home = mkHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-cwd-'));
  const sessionId = `sess-${process.pid}-${Date.now()}-nomf`;
  try {
    seedConfig(home, 'cortex_auto_recall:\n  on_memory_fire: false\n');
    seedStore(
      cwd,
      'mem-rebase.md',
      [
        '---',
        'name: rebase-helper',
        'description: how to rebase stacked PRs',
        'events: UserPromptSubmit',
        'trigger_prompt: rebase',
        'inject: full',
        'cortex_query: stacked PR rebase',
        '---',
        'Always rebase the base branch first.',
      ].join('\n')
    );

    // A recall stub that records each call to a counter file AND returns a
    // result. With the gate in place the stub must never run (counter stays
    // empty) and its result marker must never appear.
    const counterFile = path.join(home, 'recall-calls.log');
    const recallModule = writeRecallModule(
      home,
      `'use strict';
const fs = require('node:fs');
module.exports = {
  recall(query, projectId) {
    fs.appendFileSync(${JSON.stringify(counterFile)}, query + '\\n');
    return { query, projectId, results: [
      { id: 'cx-nomf', savedAt: new Date().toISOString(), title: 't', body: 'b', ageDays: 1 },
    ] };
  },
};
`
    );

    const res = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'help me rebase', cwd },
      {
        home,
        cwd,
        env: {
          SYNAPSYS_NO_SETUP_HINT: '1',
          SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
          SYNAPSYS_CORTEX_RECALL_MODULE: recallModule,
        },
      }
    );

    assert.equal(res.status, 0, 'hook exits 0');
    assert.match(
      res.stdout,
      /Always rebase the base branch first\./,
      'memory body injected unchanged'
    );
    assert.ok(
      !/cx-nomf/.test(res.stdout),
      'no cortex_query result appended under on_memory_fire:false'
    );
    assert.ok(
      !fs.existsSync(counterFile),
      'the inline recall is never invoked under on_memory_fire:false'
    );
  } finally {
    cleanup(home);
    cleanup(cwd);
  }
});

// Scenario (Fix 1): with no session_id in the payload, the hook keys the cache
// off injectLedger.resolveSessionId — the SAME resolver the ledger/telemetry and
// the status reporter (scripts/synapsys-recall.js) use — so the two sides agree
// on the session id. With no CLAUDE_CODE_SESSION_ID and no payload session_id,
// that resolver yields a safe (sanitized hashed-cwd) id, never "default".
test('SessionStart with no session_id keys the baseline cache off the shared resolver id', () => {
  const home = mkHome();
  try {
    const res = runHook(
      'SessionStart',
      { cwd: home },
      {
        home,
        env: {
          SYNAPSYS_CORTEX_TICKET: 'GH-519',
          SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
          SYNAPSYS_CORTEX_KEYWORDS: 'maestro cortex recall',
          SYNAPSYS_NO_SETUP_HINT: '1',
        },
      }
    );
    assert.equal(res.status, 0);

    const cacheDir = path.join(home, '.claude', 'synapsys', '.cache');
    // Poll for a cache file to appear without sleeping.
    let files = [];
    for (let i = 0; i < 200; i += 1) {
      files = fs.existsSync(cacheDir)
        ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))
        : [];
      if (files.length) break;
      for (let spin = 0; spin < 50000; spin += 1) {
        /* spin */
      }
    }
    assert.ok(files.length > 0, 'a baseline cache file is written');
    // The resolver only ever emits SAFE_ID_RE-matching ids ([A-Za-z0-9_-]).
    assert.ok(
      files.every((f) => /^[A-Za-z0-9_-]+\.json$/.test(f)),
      'cache key matches the sanitized session-id charset'
    );
    assert.ok(!files.includes('default.json'), 'the fallback is never the literal "default"');
  } finally {
    cleanup(home);
  }
});

// Scenario: Cortex MCP unavailable degrades gracefully
test('UserPromptSubmit with no cache and no recall module exits 0 and injects no block', () => {
  const home = mkHome();
  const sessionId = `sess-${process.pid}-${Date.now()}-unavail`;
  try {
    const res = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'hi', cwd: home },
      {
        home,
        env: { SYNAPSYS_NO_SETUP_HINT: '1' },
      }
    );
    assert.equal(res.status, 0, 'hook exits 0 even with cortex unavailable');
    assert.ok(!/\[cortex:auto-recall\]/.test(res.stdout), 'no auto-recall block injected');
    assert.equal((res.stderr || '').includes('Error'), false, 'no exception propagates');
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// Phase 2 — per-memory cortex_query inline append, honoring fire_mode
// ===========================================================================

// Scenario: Per-memory cortex_query runs when host memory fires
test('a fired memory with cortex_query appends recall results below its body', () => {
  const home = mkHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-cwd-'));
  const sessionId = `sess-${process.pid}-${Date.now()}-p2`;
  try {
    seedStore(
      cwd,
      'mem-rebase.md',
      [
        '---',
        'name: rebase-helper',
        'description: how to rebase stacked PRs',
        'events: UserPromptSubmit',
        'trigger_prompt: rebase',
        'inject: full',
        'cortex_query: stacked PR rebase',
        '---',
        'Always rebase the base branch first.',
      ].join('\n')
    );

    const recallModule = writeRecallModule(
      home,
      `'use strict';
module.exports = {
  recall(query, projectId) {
    return {
      query,
      projectId,
      results: [
        { id: 'cx-1', savedAt: new Date().toISOString(), title: 'restack tip', body: 'use --update-refs', ageDays: 1 },
      ],
    };
  },
};
`
    );

    const res = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'help me rebase', cwd },
      {
        home,
        cwd,
        env: {
          SYNAPSYS_NO_SETUP_HINT: '1',
          SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
          SYNAPSYS_CORTEX_RECALL_MODULE: recallModule,
        },
      }
    );

    assert.equal(res.status, 0);
    assert.match(res.stdout, /Always rebase the base branch first\./, 'memory body is injected');
    const bodyIdx = res.stdout.indexOf('Always rebase the base branch first.');
    const recallIdx = res.stdout.indexOf('cx-1');
    assert.ok(recallIdx > -1, 'cortex_query recall result is appended');
    assert.ok(recallIdx > bodyIdx, 'recall results appear BELOW the memory body');
  } finally {
    cleanup(home);
    cleanup(cwd);
  }
});

// Scenario: backward compatibility — a memory without cortex_query is unchanged
test('a fired memory without cortex_query is left unchanged (no recall, additive field)', () => {
  const home = mkHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-cwd-'));
  const sessionId = `sess-${process.pid}-${Date.now()}-p2nc`;
  try {
    seedStore(
      cwd,
      'mem-plain.md',
      [
        '---',
        'name: plain-helper',
        'description: a plain memory',
        'events: UserPromptSubmit',
        'trigger_prompt: deploy',
        'inject: full',
        '---',
        'Run the deploy checklist.',
      ].join('\n')
    );

    const recallModule = writeRecallModule(
      home,
      `'use strict';
module.exports = { recall() { throw new Error('recall MUST NOT run for a no-cortex_query memory'); } };
`
    );

    const res = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'time to deploy', cwd },
      {
        home,
        cwd,
        env: {
          SYNAPSYS_NO_SETUP_HINT: '1',
          SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
          SYNAPSYS_CORTEX_RECALL_MODULE: recallModule,
        },
      }
    );

    assert.equal(res.status, 0, 'hook still exits 0 (recall not invoked, so no throw)');
    assert.match(res.stdout, /Run the deploy checklist\./, 'plain memory body injected unchanged');
    assert.ok(
      !/\[cortex:auto-recall\]/.test(res.stdout),
      'no cortex recall block for a plain memory'
    );
  } finally {
    cleanup(home);
    cleanup(cwd);
  }
});

// Scenario: fire_mode suppresses a re-run of the same Phase 2 query within a session
test('fire_mode suppresses a second cortex_query run for the same memory within a session', () => {
  const home = mkHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-cwd-'));
  const sessionId = `sess-${process.pid}-${Date.now()}-p2fm`;
  try {
    seedStore(
      cwd,
      'mem-once.md',
      [
        '---',
        'name: once-helper',
        'description: fires once per session',
        'events: UserPromptSubmit',
        'trigger_prompt: rebase',
        'inject: full',
        'fire_mode: once_per_session',
        'cortex_query: stacked PR rebase',
        '---',
        'Rebase guidance body.',
      ].join('\n')
    );

    // The recall stub records each invocation by appending to a counter file so
    // the second prompt can assert the query did NOT re-run.
    const counterFile = path.join(home, 'recall-calls.log');
    const recallModule = writeRecallModule(
      home,
      `'use strict';
const fs = require('node:fs');
module.exports = {
  recall(query, projectId) {
    fs.appendFileSync(${JSON.stringify(counterFile)}, query + '\\n');
    return { query, projectId, results: [
      { id: 'cx-fm', savedAt: new Date().toISOString(), title: 't', body: 'b', ageDays: 1 },
    ] };
  },
};
`
    );

    const env = {
      SYNAPSYS_NO_SETUP_HINT: '1',
      SYNAPSYS_CORTEX_PROJECT: 'claude-plugin-work',
      SYNAPSYS_CORTEX_RECALL_MODULE: recallModule,
    };

    const first = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'please rebase', cwd },
      { home, cwd, env }
    );
    assert.equal(first.status, 0);
    assert.match(first.stdout, /cx-fm/, 'first fire runs the cortex_query and appends results');

    const second = runHook(
      'UserPromptSubmit',
      { session_id: sessionId, prompt: 'rebase again', cwd },
      { home, cwd, env }
    );
    assert.equal(second.status, 0);

    const calls = fs.existsSync(counterFile)
      ? fs.readFileSync(counterFile, 'utf8').split('\n').filter(Boolean)
      : [];
    assert.equal(
      calls.length,
      1,
      'fire_mode suppresses the second cortex_query run within the session'
    );
  } finally {
    cleanup(home);
    cleanup(cwd);
  }
});

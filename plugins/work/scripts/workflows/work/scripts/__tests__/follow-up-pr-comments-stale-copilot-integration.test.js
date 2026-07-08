'use strict';

/**
 * Integration test: handleSnapshot() must invoke the Copilot stale-thread
 * heuristic (classifyOutdatedCopilotThread) in the outdated-thread branch
 * so that R1 actually flips the per-comment status based on
 * gitHunkChangedSince(...) instead of unconditionally stamping 'resolved'.
 *
 * We mock:
 *   - ../follow-up-pr (ghExec / getResolvedCommentIds / hash / priority)
 *   - ../../follow-up/lib/git-hunk-changed (gitHunkChangedSince)
 *   - TASKS_BASE + WORK_TICKET_ID env so state is written to a tmp dir.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT_PATH = path.resolve(__dirname, '..', 'follow-up-pr-comments.js');
const FOLLOW_UP_PR_PATH = path.resolve(__dirname, '..', 'follow-up-pr.js');
const GIT_HUNK_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'follow-up',
  'lib',
  'git-hunk-changed.js'
);

function makeCopilotOutdatedComment(overrides = {}) {
  return {
    id: 9001,
    user: { login: 'copilot-pull-request-reviewer' },
    body: 'Consider null-checking here',
    path: 'src/handler.js',
    line: null,
    original_line: 42,
    position: null,
    original_position: 5,
    position_outdated: true,
    created_at: '2026-05-01T00:00:00Z',
    in_reply_to_id: null,
    ...overrides,
  };
}

function installFollowUpPrMock(inlineComments) {
  delete require.cache[FOLLOW_UP_PR_PATH];
  const fakeModule = {
    ghExec(cmd) {
      // cmd may be string ("repo view --json nameWithOwner", "pr view N --json reviews")
      // or array (["api", "repos/...pulls/N/comments?..."])
      if (typeof cmd === 'string') {
        if (cmd.includes('repo view')) return { nameWithOwner: 'acme/widgets' };
        if (cmd.includes('pr view')) return { reviews: [] };
      }
      if (Array.isArray(cmd) && cmd[0] === 'api') {
        const url = String(cmd[1] || '');
        // Return the comments on page=1, empty on page>=2 to terminate pagination.
        if (/page=1\b/.test(url)) return inlineComments;
        return [];
      }
      return null;
    },
    getResolvedCommentIds() {
      return { resolved: new Set(), outdatedThreadIds: new Set() };
    },
    computeCommentHash(p, b) {
      return `${p || 'null'}::${(b || '').slice(0, 16)}`;
    },
    classifyCommentPriority() {
      return 'medium';
    },
  };
  require.cache[FOLLOW_UP_PR_PATH] = {
    id: FOLLOW_UP_PR_PATH,
    filename: FOLLOW_UP_PR_PATH,
    loaded: true,
    exports: fakeModule,
    children: [],
    paths: [],
  };
}

function installGitHunkMock(returnValue) {
  delete require.cache[GIT_HUNK_PATH];
  require.cache[GIT_HUNK_PATH] = {
    id: GIT_HUNK_PATH,
    filename: GIT_HUNK_PATH,
    loaded: true,
    exports: {
      gitHunkChangedSince() {
        return returnValue;
      },
    },
    children: [],
    paths: [],
  };
}

function loadScript() {
  delete require.cache[SCRIPT_PATH];
  return require(SCRIPT_PATH);
}

describe('follow-up-pr-comments — handleSnapshot wires Copilot stale-thread heuristic (R1)', () => {
  let tmpDir;
  let prevTasksBase;
  let prevTicketId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fupcc-int-'));
    prevTasksBase = process.env.TASKS_BASE;
    prevTicketId = process.env.WORK_TICKET_ID;
    process.env.TASKS_BASE = tmpDir;
    process.env.WORK_TICKET_ID = 'GH-531';
  });

  afterEach(() => {
    if (prevTasksBase === undefined) delete process.env.TASKS_BASE;
    else process.env.TASKS_BASE = prevTasksBase;
    if (prevTicketId === undefined) delete process.env.WORK_TICKET_ID;
    else process.env.WORK_TICKET_ID = prevTicketId;
    delete require.cache[FOLLOW_UP_PR_PATH];
    delete require.cache[GIT_HUNK_PATH];
    delete require.cache[SCRIPT_PATH];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runSnapshotCatchingExit(mod, pr) {
    const origExit = process.exit;
    let exitCode = null;
    process.exit = (code) => {
      if (exitCode === null) {
        exitCode = code;
        throw new Error(`__exit_${code}__`);
      }
      // Suppress subsequent exits (handleSnapshot's catch may call exit(2)
      // after intercepting our thrown sentinel — we already captured the
      // real exit code from the first call).
    };
    try {
      try {
        mod.handleSnapshot(pr);
      } catch (e) {
        if (!/^__exit_/.test(e.message)) throw e;
      }
    } finally {
      process.exit = origExit;
    }
    return exitCode;
  }

  it('Fixture A: code UNCHANGED since created_at → comment remains unsolved (no false positive)', () => {
    installFollowUpPrMock([makeCopilotOutdatedComment()]);
    installGitHunkMock(false); // hunk did NOT change
    const mod = loadScript();

    const code = runSnapshotCatchingExit(mod, '123');
    assert.equal(code, 0, 'handleSnapshot should exit 0 on success');

    const statePath = path.join(tmpDir, 'GH-531', 'follow-up-comments.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.comments.length, 1);
    const c = state.comments[0];
    assert.equal(c.id, 9001);
    assert.equal(
      c.status,
      'unsolved',
      'Copilot stale-thread heuristic must NOT auto-resolve when hunk is unchanged'
    );
    assert.equal(c.resolution, null);
  });

  it('Fixture B: code CHANGED since created_at → comment resolved with stale-thread reason', () => {
    installFollowUpPrMock([makeCopilotOutdatedComment({ id: 9002 })]);
    installGitHunkMock(true); // hunk CHANGED
    const mod = loadScript();

    const code = runSnapshotCatchingExit(mod, '123');
    assert.equal(code, 0);

    const statePath = path.join(tmpDir, 'GH-531', 'follow-up-comments.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.comments.length, 1);
    const c = state.comments[0];
    assert.equal(c.id, 9002);
    assert.equal(c.status, 'resolved');
    assert.match(
      c.resolution || '',
      /Copilot stale-thread heuristic/,
      'resolution should reference the Copilot stale-thread heuristic'
    );
  });

  it('Fixture C: threadId-only previousStatus (no .status) still routes to Copilot heuristic', () => {
    // Seed prior state with a threadId-only entry (GH-358-style preservation
    // for non-terminal comments). Without the `!previousStatus?.status` guard,
    // the truthy previousStatus would skip the Copilot default and the
    // snapshot would auto-resolve the unchanged-hunk thread.
    const ticketDir = path.join(tmpDir, 'GH-531');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, 'follow-up-comments.json'),
      JSON.stringify({ comments: [{ id: 9003, threadId: 'thread-abc' }] })
    );

    installFollowUpPrMock([makeCopilotOutdatedComment({ id: 9003 })]);
    installGitHunkMock(false); // hunk UNCHANGED — must stay unsolved
    const mod = loadScript();

    const code = runSnapshotCatchingExit(mod, '123');
    assert.equal(code, 0);

    const state = JSON.parse(
      fs.readFileSync(path.join(ticketDir, 'follow-up-comments.json'), 'utf8')
    );
    const c = state.comments.find((x) => x.id === 9003);
    assert.ok(c, 'comment 9003 must be in the snapshot');
    assert.equal(
      c.status,
      'unsolved',
      'threadId-only previousStatus must not bypass the Copilot stale-thread guard'
    );
    assert.equal(c.resolution, null);
    assert.equal(c.threadId, 'thread-abc', 'threadId should be preserved');
  });
});

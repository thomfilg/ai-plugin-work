'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'follow-up-pr-comments.js');
const GIT_HUNK_REQUEST_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'follow-up',
  'lib',
  'git-hunk-changed.js'
);

/**
 * Inject a mock for `git-hunk-changed.js` into the require cache so that
 * when `follow-up-pr-comments.js` does `require('.../git-hunk-changed')`,
 * it receives our stubbed implementation. We also clear the script cache
 * so a fresh require picks up the mock.
 */
function installGitHunkMock(returnValue, calls) {
  // Clear any existing cached script + mock target.
  delete require.cache[SCRIPT_PATH];
  delete require.cache[GIT_HUNK_REQUEST_PATH];

  const fakeModule = {
    gitHunkChangedSince(filePath, originalLine, sinceIso, ctx) {
      calls.push({ filePath, originalLine, sinceIso, ctx });
      return typeof returnValue === 'function'
        ? returnValue({ filePath, originalLine, sinceIso, ctx })
        : returnValue;
    },
  };

  // Pre-seed require cache for git-hunk-changed.
  require.cache[GIT_HUNK_REQUEST_PATH] = {
    id: GIT_HUNK_REQUEST_PATH,
    filename: GIT_HUNK_REQUEST_PATH,
    loaded: true,
    exports: fakeModule,
    children: [],
    paths: [],
  };
}

function loadScript() {
  delete require.cache[SCRIPT_PATH];
  return require(SCRIPT_PATH);
}

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

describe('follow-up-pr-comments — Copilot stale-thread heuristic', () => {
  let calls;

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    delete require.cache[GIT_HUNK_REQUEST_PATH];
    delete require.cache[SCRIPT_PATH];
  });

  it('Copilot stale thread auto-resolved when code changed since created_at', () => {
    installGitHunkMock(true, calls);
    const mod = loadScript();

    assert.equal(
      typeof mod.classifyOutdatedCopilotThread,
      'function',
      'follow-up-pr-comments.js must export classifyOutdatedCopilotThread for stale-thread heuristic'
    );

    const comment = makeCopilotOutdatedComment();
    const result = mod.classifyOutdatedCopilotThread(comment, {
      previousStatus: null,
    });

    assert.equal(result.status, 'resolved');
    assert.match(
      result.resolution,
      /Copilot stale-thread heuristic/,
      'resolution should reference the Copilot stale-thread heuristic'
    );
    // gitHunkChangedSince must have been consulted with the original line + created_at.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].filePath, 'src/handler.js');
    assert.equal(calls[0].originalLine, 42);
    assert.equal(calls[0].sinceIso, '2026-05-01T00:00:00Z');
  });

  it('Stale-thread heuristic does not false-positive on unchanged code', () => {
    installGitHunkMock(false, calls);
    const mod = loadScript();

    assert.equal(typeof mod.classifyOutdatedCopilotThread, 'function');

    const comment = makeCopilotOutdatedComment({ id: 9002 });
    const result = mod.classifyOutdatedCopilotThread(comment, {
      previousStatus: null,
    });

    assert.equal(
      result.status,
      'unsolved',
      'unchanged code must NOT be marked resolved by the heuristic'
    );
    assert.equal(
      result.resolution,
      null,
      'unchanged-code path must leave resolution null (no false positive)'
    );
    assert.equal(calls.length, 1, 'heuristic must still consult gitHunkChangedSince');
  });
});

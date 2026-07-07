'use strict';

/**
 * Dual-runtime tests for the two review Stop hooks (WP-06 / C8):
 * work-code-review-status.js and work-suggestion-replies.js.
 *
 * On claude these hooks are gated by the hooks.json Stop matcher; codex
 * ignores Stop matchers entirely and fires them on EVERY stop, so each
 * script re-applies the matcher regex to payload.last_assistant_message
 * in-code. Claude behavior (no last_assistant_message in Stop payloads)
 * must be unchanged: still blocks on a bad recent review.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REVIEW_HOOK = path.resolve(__dirname, '..', 'work-code-review-status.js');
const REPLIES_HOOK = path.resolve(__dirname, '..', 'work-suggestion-replies.js');

const REVIEW_MD = [
  '# Code Review',
  '',
  '### 🔴 CRITICAL ISSUES',
  '- **Security: Hardcoded token**: secret committed in source',
  '',
  'Status: APPROVED',
  '',
].join('\n');

describe('review Stop hooks — dual runtime self-filter', () => {
  let tmp;
  let cwd;
  let envBase;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hooks-rt-'));
    cwd = path.join(tmp, 'my-project-PROJ-123');
    const taskDir = path.join(cwd, 'tasks', 'PROJ-123');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'code-review.check.md'), REVIEW_MD);
    envBase = {
      WORKTREES_BASE: tmp,
      TASKS_BASE: path.join(tmp, 'tasks'),
      REPO_NAME: 'my-project',
      TICKET_PROJECT_KEY: 'PROJ',
      TICKET_PROVIDER: '',
      JIRA_PROJECT_KEY: '',
    };
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runHook(hook, payload, env = {}) {
    const merged = { ...process.env, ...envBase, ...env };
    for (const key of ['AGENT_RUNTIME', 'AGENT_SESSION_ID', 'CODEX_THREAD_ID', 'PLUGIN_ROOT']) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd,
      timeout: 15000,
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  const CODEX_PAYLOAD = {
    session_id: 'sess-1',
    turn_id: 't-1',
    transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };

  describe('work-code-review-status', () => {
    it('claude: still blocks on a recent CRITICAL review without a reply', () => {
      const r = runHook(
        REVIEW_HOOK,
        { session_id: 'sess-1', hook_event_name: 'Stop', stop_hook_active: false },
        { AGENT_RUNTIME: 'claude' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /CODE REVIEW: CRITICAL ISSUES REQUIRE RESPONSE/);
    });

    it('codex: matching last_assistant_message passes the self-filter and blocks', () => {
      const r = runHook(
        REVIEW_HOOK,
        { ...CODEX_PAYLOAD, last_assistant_message: 'Review finished: APPROVED, all good.' },
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /CODE REVIEW: CRITICAL ISSUES REQUIRE RESPONSE/);
    });

    it('codex: unrelated last_assistant_message exits 0 silently (fires every stop)', () => {
      const r = runHook(
        REVIEW_HOOK,
        { ...CODEX_PAYLOAD, last_assistant_message: 'Implemented the feature and committed.' },
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    });
  });

  describe('work-suggestion-replies', () => {
    it('claude: still blocks on missing code-review-reply', () => {
      const r = runHook(
        REPLIES_HOOK,
        { session_id: 'sess-1', hook_event_name: 'Stop', stop_hook_active: false },
        { AGENT_RUNTIME: 'claude' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /MISSING CODE REVIEW REPLY/);
    });

    it('codex: matching last_assistant_message passes the self-filter and blocks', () => {
      const r = runHook(
        REPLIES_HOOK,
        { ...CODEX_PAYLOAD, last_assistant_message: 'Review finished: APPROVED, all good.' },
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /MISSING CODE REVIEW REPLY/);
    });

    it('codex: unrelated last_assistant_message exits 0 silently', () => {
      const r = runHook(
        REPLIES_HOOK,
        { ...CODEX_PAYLOAD, last_assistant_message: 'Implemented the feature and committed.' },
        { AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    });
  });
});

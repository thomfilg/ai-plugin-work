'use strict';

/**
 * Dual-runtime tests for enforce-env-start-failure.js (WP-07):
 *   - phase 2 gates BOTH runtimes' dispatch tools (Task/Skill on claude,
 *     spawn_agent — the `Agent` matcher alias target — on codex)
 *   - the block guidance renders the runtime's question tool (vocab C13:
 *     AskUserQuestion → plain-chat numbered options on codex, claude byte-identical)
 *   - phase 3 clears the marker on BOTH question tool names
 *   - phase 1 on codex reads the Bash output from payload.tool_response
 *     (plain string — the claude transcript scan can't read rollouts)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'enforce-env-start-failure.js');

describe('enforce-env-start-failure — dual runtime', () => {
  let tmp;
  let repoDir;
  let envBase;
  let ticketId;
  let markerFile;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-start-rt-'));
    ticketId = `TEST-${process.pid}`;
    repoDir = path.join(tmp, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    execSync(`git init -q -b ${ticketId}-env-check ${repoDir}`);
    markerFile = `/tmp/check-env-failed-${ticketId}`;
    envBase = {
      WORKTREES_BASE: tmp,
      TASKS_BASE: path.join(tmp, 'tasks'),
      REPO_NAME: 'repo',
      TICKET_PROJECT_KEY: 'TEST',
      TICKET_PROVIDER: '',
      JIRA_PROJECT_KEY: '',
    };
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(markerFile, { force: true });
    fs.rmSync(`/tmp/check-skip-qa-${ticketId}`, { force: true });
  });

  function runHook(payload, env = {}) {
    const merged = { ...process.env, ...envBase, ...env };
    for (const key of ['AGENT_RUNTIME', 'AGENT_SESSION_ID', 'CODEX_THREAD_ID', 'PLUGIN_ROOT']) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      cwd: repoDir,
      timeout: 15000,
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  function writeMarker() {
    // The marker path is dictated by the hook under test (MARKER_DIR is a
    // hardcoded '/tmp'), so it cannot live in the mkdtemp dir. Remove any
    // pre-existing file so the 0o600 mode applies on create (CodeQL
    // js/insecure-temporary-file: owner-only bits on temp-dir writes).
    fs.rmSync(markerFile, { force: true });
    fs.writeFileSync(
      markerFile,
      JSON.stringify({ failedApps: ['web'], ticketId, timestamp: new Date().toISOString() }),
      { mode: 0o600 }
    );
  }

  it('claude: Task blocked while marker exists — AskUserQuestion guidance (characterization)', () => {
    writeMarker();
    const r = runHook(
      { tool_name: 'Task', tool_input: { subagent_type: 'qa-feature-tester' } },
      { AGENT_RUNTIME: 'claude', CLAUDE_HOOK_TYPE: 'PreToolUse' }
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Call AskUserQuestion with options/);
  });

  it('codex: spawn_agent blocked while marker exists — plain-chat question guidance', () => {
    writeMarker();
    const r = runHook(
      {
        session_id: 's-1',
        turn_id: 't-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'spawn_agent',
        tool_input: { agent_type: 'qa-feature-tester' },
      },
      { AGENT_RUNTIME: 'codex', CLAUDE_HOOK_TYPE: 'PreToolUse' }
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Call a plain-chat question with numbered options .* with options/);
    assert.doesNotMatch(r.stderr, /AskUserQuestion/);
  });

  it('codex: request_user_input on PostToolUse clears the marker (phase 3)', () => {
    writeMarker();
    const r = runHook(
      {
        session_id: 's-1',
        turn_id: 't-1',
        hook_event_name: 'PostToolUse',
        tool_name: 'request_user_input',
        tool_input: {},
      },
      { AGENT_RUNTIME: 'codex', CLAUDE_HOOK_TYPE: 'PostToolUse' }
    );
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(markerFile), false);
  });

  it('codex: phase 1 detects the failure from payload.tool_response (string)', () => {
    fs.rmSync(markerFile, { force: true });
    const r = runHook(
      {
        session_id: 's-1',
        turn_id: 't-1',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'node check-start-env.js' },
        tool_response: '{"apps": {"web": {"name": "web", "started": false, "port": 3000}}}',
      },
      { AGENT_RUNTIME: 'codex', CLAUDE_HOOK_TYPE: 'PostToolUse' }
    );
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(markerFile), true);
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.deepEqual(marker.failedApps, ['web']);
    fs.rmSync(markerFile, { force: true });
  });

  it('codex: phase 1 clears a stale marker when the payload output is healthy', () => {
    writeMarker();
    const r = runHook(
      {
        session_id: 's-1',
        turn_id: 't-1',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'node check-start-env.js' },
        tool_response: '{"apps": {"web": {"name": "web", "started": true, "port": 3000}}}',
      },
      { AGENT_RUNTIME: 'codex', CLAUDE_HOOK_TYPE: 'PostToolUse' }
    );
    assert.equal(r.code, 0);
    assert.equal(fs.existsSync(markerFile), false);
  });
});

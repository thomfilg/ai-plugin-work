/**
 * Tests for capture-usage.js — PostToolUse hook for /work (GH-311).
 *
 * Verifies the wiring between agent-dispatch tool completions and
 * `kind:'usage'` rows in `.work-actions.json`: structured claude Task
 * response fields, `<usage>` text-block fallback, session/worktree marker
 * scoping (no cross-wiring), sub-agent suppression, and step attribution
 * from `.work-state.json`.
 *
 * node:test + node:assert/strict; temp TASKS_BASE via fs.mkdtempSync.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hookPath = path.join(__dirname, '..', 'capture-usage.js');
const { ALL_STEPS } = require(path.join(__dirname, '..', '..', 'step-registry'));

const MARKER = '.work.pid';
const SESSION = 'sess-usage-1';

let TASKS_BASE;

function runHook(hookData, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify(hookData),
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...env },
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function ownedEnv() {
  return {
    TASKS_BASE,
    WORKTREES_BASE: path.dirname(TASKS_BASE),
    CLAUDE_CODE_SESSION_ID: SESSION,
  };
}

function writeMarker(ticket, fields = {}) {
  const dir = path.join(TASKS_BASE, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MARKER),
    JSON.stringify({
      ticket,
      startedAt: new Date().toISOString(),
      workflow: '/work',
      sessionId: SESSION,
      ...fields,
    })
  );
}

function writeState(ticket, stepName) {
  const dir = path.join(TASKS_BASE, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.work-state.json'),
    JSON.stringify({ ticketId: ticket, currentStep: ALL_STEPS.indexOf(stepName) + 1 })
  );
}

function loadRows(ticket) {
  const file = path.join(TASKS_BASE, ticket, '.work-actions.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function taskPayload(overrides = {}) {
  return {
    tool_name: 'Task',
    tool_input: { subagent_type: 'developer-nodejs-tdd', prompt: 'do the thing' },
    tool_response: {
      content: [{ type: 'text', text: 'done' }],
      totalTokens: 120000,
      totalToolUseCount: 40,
      totalDurationMs: 60000,
    },
    transcript_path: '/tmp/t.jsonl',
    session_id: SESSION,
    ...overrides,
  };
}

describe('capture-usage hook', () => {
  beforeEach(() => {
    TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-usage-test-'));
  });
  afterEach(() => {
    fs.rmSync(TASKS_BASE, { recursive: true, force: true });
  });

  it('appends a usage row from structured claude Task response fields', () => {
    writeMarker('GH-900');
    writeState('GH-900', 'implement');

    const r = runHook(taskPayload(), ownedEnv());
    assert.equal(r.exitCode, 0);

    const rows = loadRows('GH-900');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'usage');
    assert.equal(rows[0].step, 'implement');
    assert.equal(rows[0].agentType, 'developer-nodejs-tdd');
    assert.equal(rows[0].totalTokens, 120000);
    assert.equal(rows[0].toolUses, 40);
    assert.equal(rows[0].durationMs, 60000);
  });

  it('falls back to the <usage> text block when structured fields are absent', () => {
    writeMarker('GH-901');
    writeState('GH-901', 'check');

    const text =
      'agent done\n<usage>\ntotal_tokens: 5000\ntool_uses: 7\nduration_ms: 9000\n</usage>';
    const r = runHook(
      taskPayload({ tool_response: { content: [{ type: 'text', text }] } }),
      ownedEnv()
    );
    assert.equal(r.exitCode, 0);

    const rows = loadRows('GH-901');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step, 'check');
    assert.equal(rows[0].totalTokens, 5000);
    assert.equal(rows[0].toolUses, 7);
    assert.equal(rows[0].durationMs, 9000);
  });

  it('parses a plain-string tool_response carrying a <usage> block', () => {
    writeMarker('GH-902');
    writeState('GH-902', 'implement');

    const r = runHook(
      taskPayload({
        tool_response: '<usage>\ntotal_tokens: 111\ntool_uses: 2\nduration_ms: 300\n</usage>',
      }),
      ownedEnv()
    );
    assert.equal(r.exitCode, 0);
    assert.equal(loadRows('GH-902')[0].totalTokens, 111);
  });

  it('records no row when the response carries no usage signal', () => {
    writeMarker('GH-903');
    writeState('GH-903', 'implement');

    const r = runHook(
      taskPayload({ tool_response: { content: [{ type: 'text', text: 'done, no usage' }] } }),
      ownedEnv()
    );
    assert.equal(r.exitCode, 0);
    assert.equal(loadRows('GH-903').length, 0);
  });

  it('ignores non-agent tools even when their output contains a <usage> block', () => {
    writeMarker('GH-904');
    writeState('GH-904', 'implement');

    const r = runHook(
      taskPayload({
        tool_name: 'Bash',
        tool_input: { command: 'cat transcript.txt' },
        tool_response: {
          stdout: '<usage>\ntotal_tokens: 999\ntool_uses: 9\nduration_ms: 9\n</usage>',
        },
      }),
      ownedEnv()
    );
    assert.equal(r.exitCode, 0);
    assert.equal(loadRows('GH-904').length, 0, 'Bash output must not be recorded as agent usage');
  });

  it('does NOT record against a marker owned by a foreign session', () => {
    writeMarker('GH-905', { sessionId: 'owner-A', worktreeRoot: '/wt/a' });
    writeState('GH-905', 'implement');

    const r = runHook(taskPayload({ session_id: 'other-B' }), {
      TASKS_BASE,
      WORKTREES_BASE: path.dirname(TASKS_BASE),
      CLAUDE_CODE_SESSION_ID: 'other-B',
    });
    assert.equal(r.exitCode, 0);
    assert.equal(loadRows('GH-905').length, 0, 'must not cross-wire a foreign /work session');
  });

  it('does NOT record from within a sub-agent transcript', () => {
    writeMarker('GH-906');
    writeState('GH-906', 'implement');

    const r = runHook(taskPayload({ transcript_path: '/x/subagents/y.jsonl' }), ownedEnv());
    assert.equal(r.exitCode, 0);
    assert.equal(loadRows('GH-906').length, 0);
  });

  it("attributes to step 'unknown' when the state file is missing", () => {
    writeMarker('GH-907'); // marker but no .work-state.json

    const r = runHook(taskPayload(), ownedEnv());
    assert.equal(r.exitCode, 0);

    const rows = loadRows('GH-907');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step, 'unknown');
    assert.equal(rows[0].totalTokens, 120000);
  });

  it('exits 0 silently when no marker exists', () => {
    const r = runHook(taskPayload(), ownedEnv());
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });
});

/**
 * Integration tests for context-monitor.js — PostToolUse hook for /work
 * (GH-313, Task 3).
 *
 * The monitor is a fail-open PostToolUse hook that, after an agent-dispatch
 * completion, reads the session's cumulative transcript token usage, compares
 * it against the model context limit, and emits an advisory warning per newly
 * crossed threshold (default 60/70/80%). It never blocks a tool call.
 *
 * These tests spawn the hook with child_process.execFileSync (the established
 * exit-code harness, mirroring capture-usage.test.js) against a temp
 * TASKS_BASE, asserting:
 *   - fail-open exit 0 for foreign-marker / sub-agent / missing-transcript
 *   - the hooks.json registration line under the Task|Agent PostToolUse lane
 *   - first-crossing warning content (step, agent, "62%"), exit 0
 *   - no-repeat on a second run (crossed-threshold ledger)
 *   - critical recommendation at the highest threshold
 *   - the WORK_CONTEXT_MONITOR_ENABLED=0 silent no-op
 *
 * node:test + node:assert/strict; temp TASKS_BASE via fs.mkdtempSync.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..');
const hookPath = path.join(HOOKS_DIR, 'context-monitor.js');
const { ALL_STEPS } = require(path.join(HOOKS_DIR, '..', 'step-registry'));

const MARKER = '.work.pid';
const LEDGER = '.context-monitor.json';
const SESSION = 'sess-ctx-1';

let TASKS_BASE;

/**
 * Spawn the hook, feeding `hookData` on stdin. Captures exit code + streams.
 * Warnings ride emit.context which, on the claude leg, prints the message to
 * stdout — so the emitted warning text is observable via r.stdout.
 */
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

function ownedEnv(extra = {}) {
  return {
    TASKS_BASE,
    WORKTREES_BASE: path.dirname(TASKS_BASE),
    CLAUDE_CODE_SESSION_ID: SESSION,
    ...extra,
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

/**
 * Write a transcript JSONL whose per-turn `usage` blocks sum to `tokens`
 * (a single input-token turn is enough — context-usage sums input+output).
 */
function writeTranscript(ticket, tokens) {
  const dir = path.join(TASKS_BASE, ticket);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'transcript.jsonl');
  const line = JSON.stringify({ message: { usage: { input_tokens: tokens, output_tokens: 0 } } });
  fs.writeFileSync(file, line + '\n');
  return file;
}

function readLedger(ticket) {
  const file = path.join(TASKS_BASE, ticket, LEDGER);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeLedger(ticket, crossed) {
  const dir = path.join(TASKS_BASE, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LEDGER), JSON.stringify({ crossed }));
}

/** Dispatch payload: a claude Task completion at `tokens` of the limit. */
function taskPayload(ticket, tokens, overrides = {}) {
  const transcript = writeTranscript(ticket, tokens);
  return {
    tool_name: 'Task',
    tool_input: { subagent_type: 'developer-nodejs-tdd', prompt: 'do the thing' },
    tool_response: { content: [{ type: 'text', text: 'done' }], totalTokens: tokens },
    transcript_path: transcript,
    session_id: SESSION,
    ...overrides,
  };
}

describe('context-monitor hook — fail-open scoping + hooks.json registration', () => {
  beforeEach(() => {
    TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'context-monitor-test-'));
  });
  afterEach(() => {
    fs.rmSync(TASKS_BASE, { recursive: true, force: true });
  });

  it('is registered in hooks.json under the Task|Agent PostToolUse lane', () => {
    const hooksJsonPath = path.join(HOOKS_DIR, '..', '..', '..', '..', 'hooks', 'hooks.json');
    const raw = fs.readFileSync(hooksJsonPath, 'utf8');
    assert.match(raw, /context-monitor\.js/, 'hooks.json must register context-monitor.js');

    const cfg = JSON.parse(raw);
    const lane = cfg.hooks.PostToolUse.find(
      (l) =>
        l.matcher === 'Task|Agent' && l.hooks.some((h) => /context-monitor\.js/.test(h.command))
    );
    assert.ok(lane, 'context-monitor.js must live in the Task|Agent PostToolUse lane');
    const capture = lane.hooks.some((h) => /capture-usage\.js/.test(h.command));
    assert.ok(capture, 'must sit alongside capture-usage.js in the same lane');
  });

  it('is a silent no-op (exit 0, no warning) for a foreign-session marker', () => {
    writeMarker('GH-800', { sessionId: 'owner-A', worktreeRoot: '/wt/a' });
    writeState('GH-800', 'implement');

    const r = runHook(taskPayload('GH-800', 124000, { session_id: 'other-B' }), {
      TASKS_BASE,
      WORKTREES_BASE: path.dirname(TASKS_BASE),
      CLAUDE_CODE_SESSION_ID: 'other-B',
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '', 'must not warn on a foreign /work session');
    assert.equal(readLedger('GH-800'), null, 'must not write a ledger for a foreign session');
  });

  it('is a silent no-op (exit 0, no warning) from within a sub-agent context', () => {
    writeMarker('GH-801');
    writeState('GH-801', 'implement');

    const r = runHook(
      taskPayload('GH-801', 124000, { transcript_path: '/x/subagents/y.jsonl' }),
      ownedEnv()
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '', 'sub-agent context must be suppressed');
    assert.equal(readLedger('GH-801'), null);
  });

  it('exits 0 with no warning when the transcript is missing/unreadable', () => {
    writeMarker('GH-802');
    writeState('GH-802', 'implement');

    const r = runHook(
      taskPayload('GH-802', 0, { transcript_path: path.join(TASKS_BASE, 'GH-802', 'nope.jsonl') }),
      ownedEnv()
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '', 'a missing transcript must never block or warn');
  });

  it('exits 0 silently when no /work marker exists', () => {
    const r = runHook(taskPayload('GH-803', 124000), ownedEnv());
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });
});

describe('context-monitor hook — threshold warnings, ledger, critical, disable', () => {
  beforeEach(() => {
    TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'context-monitor-test-'));
  });
  afterEach(() => {
    fs.rmSync(TASKS_BASE, { recursive: true, force: true });
  });

  it('warns once at the first crossed threshold naming step, agent, and percent', () => {
    writeMarker('GH-810');
    writeState('GH-810', 'implement');

    // 124000 / 200000 = 62% → crosses the 60% threshold only.
    const r = runHook(taskPayload('GH-810', 124000), ownedEnv());
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /62%/, 'warning must name the integer percent consumed');
    assert.match(r.stdout, /implement/, 'warning must name the active workflow step');
    assert.match(r.stdout, /developer-nodejs-tdd/, 'warning must name the dispatched agent');
    assert.ok(!/70%|80%/.test(r.stdout), 'only the 60% threshold should fire at 62%');

    const ledger = readLedger('GH-810');
    assert.deepEqual(ledger, { crossed: [60] }, 'the crossed threshold is persisted to the ledger');
  });

  it('does not re-warn a threshold already recorded in the ledger', () => {
    writeMarker('GH-811');
    writeState('GH-811', 'implement');
    writeLedger('GH-811', [60]);

    // Still 62% — 60 already crossed, so nothing new fires.
    const r = runHook(taskPayload('GH-811', 124000), ownedEnv());
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '', 'a threshold already in the ledger must not warn twice');
    assert.deepEqual(readLedger('GH-811'), { crossed: [60] });
  });

  it('appends the commit + fresh-agent recommendation at the critical threshold', () => {
    writeMarker('GH-812');
    writeState('GH-812', 'implement');

    // 170000 / 200000 = 85% → crosses 60, 70, and the critical 80.
    const r = runHook(taskPayload('GH-812', 170000), ownedEnv());
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /85%/);
    assert.match(r.stdout, /commit/i, 'critical warning must recommend committing current work');
    assert.match(r.stdout, /fresh agent/i, 'critical warning must recommend a fresh agent');

    const ledger = readLedger('GH-812');
    assert.deepEqual(
      ledger.crossed.sort((a, b) => a - b),
      [60, 70, 80]
    );
  });

  it('honors WORK_CONTEXT_WARN_THRESHOLDS, firing the configured percentages', () => {
    writeMarker('GH-813');
    writeState('GH-813', 'implement');

    // 110000 / 200000 = 55% with thresholds "50,90" → only 50 fires.
    const r = runHook(
      taskPayload('GH-813', 110000),
      ownedEnv({ WORK_CONTEXT_WARN_THRESHOLDS: '50,90' })
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /55%/);
    assert.ok(!/60%/.test(r.stdout), 'the default 60% threshold must not fire when overridden');
    assert.deepEqual(readLedger('GH-813'), { crossed: [50] });
  });

  it('falls back to default thresholds when WORK_CONTEXT_WARN_THRESHOLDS is invalid', () => {
    writeMarker('GH-814');
    writeState('GH-814', 'implement');

    // 130000 / 200000 = 65%; invalid env → defaults [60,70,80] → only 60 fires.
    const r = runHook(
      taskPayload('GH-814', 130000),
      ownedEnv({ WORK_CONTEXT_WARN_THRESHOLDS: 'not-a-number' })
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /65%/);
    assert.deepEqual(readLedger('GH-814'), { crossed: [60] });
  });

  it('is a silent no-op when WORK_CONTEXT_MONITOR_ENABLED=0', () => {
    writeMarker('GH-815');
    writeState('GH-815', 'implement');

    const r = runHook(
      taskPayload('GH-815', 170000),
      ownedEnv({ WORK_CONTEXT_MONITOR_ENABLED: '0' })
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '', 'the disable switch must silence the monitor');
    assert.equal(readLedger('GH-815'), null, 'disabled monitor must not write a ledger');
  });

  it('honors WORK_CONTEXT_LIMIT when computing percent', () => {
    writeMarker('GH-816');
    writeState('GH-816', 'implement');

    // 124000 tokens against a 400000 limit = 31% → below every threshold.
    const r = runHook(taskPayload('GH-816', 124000), ownedEnv({ WORK_CONTEXT_LIMIT: '400000' }));
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '', 'no threshold is crossed at 31% of a raised limit');
    assert.equal(readLedger('GH-816'), null);
  });
});

'use strict';

/**
 * Dual-runtime tests for enforce-coverage-fix.js (WP-07):
 *   - claude: legacy transcript scan + plain stdout banner, byte-identical
 *   - codex: coverage detection reads the payload tool_response (string) and
 *     the rollout via the dual-format reader; the banner rides the
 *     PostToolUse hookSpecificOutput.additionalContext envelope (C2 — plain
 *     stdout is never injected there)
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'enforce-coverage-fix.js');

const cleanupFiles = [];
after(() => {
  while (cleanupFiles.length > 0) {
    try {
      fs.unlinkSync(cleanupFiles.pop());
    } catch {
      /* already gone */
    }
  }
});

function runHook(input, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const key of ['AGENT_RUNTIME', 'AGENT_SESSION_ID', 'CODEX_THREAD_ID', 'PLUGIN_ROOT']) {
    if (!(key in envOverrides)) delete env[key];
  }
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
    env,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function writeTranscript(lines, suffix) {
  const file = path.join(
    os.tmpdir(),
    `covfix-rt-${suffix}-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  cleanupFiles.push(file);
  return file;
}

function claudeTranscript() {
  return writeTranscript([{ type: 'tool_result', content: 'clean output' }], 'claude');
}

function codexRollout(outputText) {
  return writeTranscript(
    [
      {
        type: 'session_meta',
        payload: { id: 's-1', cwd: '/tmp/x', timestamp: '2026-07-07T00:00:00Z' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'c1',
          arguments: JSON.stringify({ cmd: 'gh pr checks 42' }),
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: outputText },
      },
    ],
    'codex'
  );
}

describe('enforce-coverage-fix — dual runtime', () => {
  it('claude: banner goes to plain stdout (characterization)', () => {
    const tp = writeTranscript(
      [{ type: 'tool_result', content: 'coverage decrease detected in modified files' }],
      'claude-fail'
    );
    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'gh pr checks 42' },
        transcript_path: tp,
      },
      { AGENT_RUNTIME: 'claude' }
    );
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^🛑 COVERAGE FAILURE DETECTED IN CI OUTPUT/);
    assert.match(r.stdout, /MANDATORY: Run \/test-coordination NOW/);
    assert.doesNotMatch(r.stdout, /hookSpecificOutput/);
  });

  it('codex: payload tool_response feeds detection; banner rides the envelope', () => {
    const tp = codexRollout('all green');
    const r = runHook(
      {
        session_id: 's-1',
        turn_id: 't-1',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr checks 42' },
        tool_response: 'check-modified-files-coverage FAILED: coverage decrease',
        transcript_path: tp,
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    const envelope = JSON.parse(r.stdout);
    assert.equal(envelope.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(
      envelope.hookSpecificOutput.additionalContext,
      /COVERAGE FAILURE DETECTED IN CI OUTPUT/
    );
  });

  it('codex: rollout tool outputs feed detection when the payload is clean', () => {
    const tp = codexRollout('vitest-coverage-report: please add tests to maintain');
    const r = runHook(
      {
        session_id: 's-1',
        turn_id: 't-1',
        tool_name: 'Bash',
        tool_input: { command: 'gh run view 99' },
        tool_response: 'exit status 1',
        transcript_path: tp,
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    const envelope = JSON.parse(r.stdout);
    assert.match(envelope.hookSpecificOutput.additionalContext, /COVERAGE FAILURE DETECTED/);
  });

  it('codex: no coverage signal → silent exit 0', () => {
    const tp = codexRollout('all checks passed');
    const r = runHook(
      {
        session_id: 's-1',
        turn_id: 't-1',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr checks 42' },
        tool_response: 'all checks passed',
        transcript_path: tp,
      },
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  it('claude: clean transcript stays silent (characterization)', () => {
    const r = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'gh pr checks 42' },
        transcript_path: claudeTranscript(),
      },
      { AGENT_RUNTIME: 'claude' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });
});

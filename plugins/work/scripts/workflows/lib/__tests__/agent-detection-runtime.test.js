'use strict';

/**
 * Dual-runtime tests for agent-detection (WP-07): payload agent_type is the
 * PRIMARY identity signal (design C12 — codex sets no CLAUDE_* env vars),
 * and codex rollout transcripts route through the vendored reader's
 * spawn_agent dispatch scan instead of the claude line-scan helpers.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isRunningInAgent } = require(path.resolve(__dirname, '..', 'agent-detection.js'));

function writeRollout(records) {
  const file = path.join(
    os.tmpdir(),
    `agent-detect-rt-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  const meta = {
    type: 'session_meta',
    payload: { id: 's-1', cwd: '/tmp/x', timestamp: '2026-07-07T00:00:00Z' },
  };
  fs.writeFileSync(file, [meta, ...records].map((r) => JSON.stringify(r)).join('\n'));
  return file;
}

function spawnAgentCall(callId, agentType) {
  return {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'spawn_agent',
      call_id: callId,
      arguments: JSON.stringify({ agent_type: agentType, prompt: 'do the work' }),
    },
  };
}

describe('agent-detection — dual runtime', () => {
  let savedCurrentAgent;
  const cleanupFiles = [];

  beforeEach(() => {
    savedCurrentAgent = process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.CLAUDE_CURRENT_AGENT;
  });
  afterEach(() => {
    if (savedCurrentAgent === undefined) delete process.env.CLAUDE_CURRENT_AGENT;
    else process.env.CLAUDE_CURRENT_AGENT = savedCurrentAgent;
    while (cleanupFiles.length > 0) {
      try {
        fs.unlinkSync(cleanupFiles.pop());
      } catch {
        /* already gone */
      }
    }
  });

  it('payload agent_type matches with no env and no transcript (payload-first)', () => {
    assert.equal(
      isRunningInAgent(undefined, ['code-checker'], { agent_type: 'code-checker' }),
      true
    );
    assert.equal(
      isRunningInAgent(undefined, ['code-checker'], {
        agent_type: 'work-workflow:code-checker',
      }),
      true
    );
  });

  it('payload agent_type mismatch falls through (no false positive)', () => {
    assert.equal(
      isRunningInAgent(undefined, ['code-checker'], { agent_type: 'pr-generator' }),
      false
    );
  });

  it('codex rollout: ACTIVE spawn_agent dispatch of an alias is detected', () => {
    const file = writeRollout([spawnAgentCall('c1', 'code-checker')]);
    cleanupFiles.push(file);
    assert.equal(isRunningInAgent(file, ['code-checker'], {}), true);
  });

  it('codex rollout: a COMPLETED spawn_agent dispatch does not match', () => {
    const file = writeRollout([
      spawnAgentCall('c1', 'code-checker'),
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: 'done' },
      },
    ]);
    cleanupFiles.push(file);
    assert.equal(isRunningInAgent(file, ['code-checker'], {}), false);
  });

  it('codex rollout: spawn_agent for a different agent does not match', () => {
    const file = writeRollout([spawnAgentCall('c1', 'pr-generator')]);
    cleanupFiles.push(file);
    assert.equal(isRunningInAgent(file, ['code-checker'], {}), false);
  });

  it('claude transcript scan still works (characterization: attributionAgent)', () => {
    const file = path.join(
      os.tmpdir(),
      `agent-detect-claude-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
    );
    fs.writeFileSync(
      file,
      [
        { type: 'user', attributionAgent: 'code-checker', message: { content: 'go' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n')
    );
    cleanupFiles.push(file);
    assert.equal(isRunningInAgent(file, ['code-checker'], {}), true);
    assert.equal(isRunningInAgent(file, ['pr-generator'], {}), false);
  });
});

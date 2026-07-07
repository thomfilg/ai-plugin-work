/**
 * Dual-runtime tests for instruction-builder.js (WP-08).
 *
 * Claude characterization: buildInstruction output is byte-identical to the
 * pre-vocabulary HEAD shapes (expected objects below are copied from the HEAD
 * literals — the vocabulary port is provably inert on Claude, including the
 * exact key set of the instruction JSON schema).
 *
 * Codex: task delegates render as inline-agent persona executions with an
 * on-disk personaPath + degradation notices (C1); skill delegates gain a
 * mention-based howTo (C13); bash/commit delegates pass through. All codex
 * fields are ADDITIVE — the claude-shaped fields survive.
 *
 * Run: node --test scripts/workflows/work/lib/__tests__/instruction-builder-runtime.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resetRuntimeCache } = require('../../../lib/runtime');
const { buildInstruction } = require('../instruction-builder');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const STATE_CTX = { ticket: 'GH-1', currentStep: 'brief' };

const ENV_KEYS = ['AGENT_RUNTIME', 'AGENT_RUNTIME_MODE', 'WORK_CODEX_SPAWN_AGENT'];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetRuntimeCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRuntimeCache();
});

function pin(runtime) {
  process.env.AGENT_RUNTIME = runtime;
  resetRuntimeCache();
}

const TASK_ENTRY = {
  step: 'brief',
  reason: 'No brief.md',
  agentType: 'brief-writer',
  agentPrompt: 'Write the brief.\nUse the ticket body.\nCite sources.\nStay in scope.',
};

describe('claude characterization — byte-identical to HEAD', () => {
  it('task entry builds the exact HEAD instruction (schema + literals)', () => {
    pin('claude');
    const instr = buildInstruction(TASK_ENTRY, STATE_CTX);
    assert.deepEqual(instr, {
      type: 'work_instruction',
      action: 'execute',
      state: STATE_CTX,
      continue: true,
      delegate: {
        type: 'task',
        agentType: 'brief-writer',
        description: 'brief No brief.md',
        prompt: TASK_ENTRY.agentPrompt,
        note: 'Pass the prompt directly to the agent. Do NOT read brief/spec/tasks files yourself — the agent reads them.',
      },
    });
    // Schema pin: exactly the HEAD key sets, in order.
    assert.deepEqual(Object.keys(instr), ['type', 'action', 'state', 'continue', 'delegate']);
    assert.deepEqual(Object.keys(instr.delegate), [
      'type',
      'agentType',
      'description',
      'prompt',
      'note',
    ]);
  });

  it('skill entry builds the exact HEAD delegate', () => {
    pin('claude');
    const instr = buildInstruction(
      { step: 'check', reason: 'run check', agentType: 'skill', agentPrompt: '/check GH-1' },
      STATE_CTX
    );
    assert.deepEqual(instr.delegate, { type: 'skill', name: 'check', prompt: '/check GH-1' });
  });

  it('bash and commit entries build the exact HEAD delegates', () => {
    pin('claude');
    const bash = buildInstruction(
      { step: 'ci', reason: 'watch', agentType: 'Bash', agentPrompt: 'gh pr checks', command: 'x' },
      STATE_CTX
    );
    assert.deepEqual(bash.delegate, {
      type: 'bash',
      description: 'ci watch',
      command: 'gh pr checks',
    });
    const commit = buildInstruction(
      { step: 'commit', reason: 'save', agentType: 'inline-commit', agentPrompt: 'Commit staged.' },
      STATE_CTX
    );
    assert.deepEqual(commit.delegate, {
      type: 'commit',
      description: 'commit save',
      prompt: 'Commit staged.',
    });
  });

  it('general-purpose single-command entry still collapses to bash', () => {
    pin('claude');
    const instr = buildInstruction(
      {
        step: 'ticket',
        reason: 'fetch',
        agentType: 'general-purpose',
        agentPrompt: 'Fetch the ticket with gh issue view 1',
      },
      STATE_CTX
    );
    assert.equal(instr.delegate.type, 'bash');
  });
});

describe('codex rendering — additive inline-agent/skill fields (C1/C13)', () => {
  it('task delegate → inline-agent with existing personaPath + notices', () => {
    pin('codex');
    const instr = buildInstruction(TASK_ENTRY, STATE_CTX);
    const d = instr.delegate;
    assert.equal(d.type, 'inline-agent');
    assert.equal(d.personaPath, path.join(PLUGIN_ROOT, 'agents', 'brief-writer.md'));
    assert.ok(fs.existsSync(d.personaPath), 'personaPath exists on disk');
    assert.match(d.howTo, /execute the prompt inline NOW, then re-run the driver/);
    assert.deepEqual(d.notices, [
      "[work:codex-degraded] subagent 'brief-writer' runs INLINE; parallel dispatch serialized",
    ]);
    // Additive: every claude-shaped field survives for schema consumers.
    assert.equal(d.agentType, 'brief-writer');
    assert.equal(d.description, 'brief No brief.md');
    assert.equal(d.prompt, TASK_ENTRY.agentPrompt);
    assert.match(d.note, /codex has no Task tool/);
  });

  it('skill delegate gains the mention howTo with the real SKILL.md path', () => {
    pin('codex');
    const instr = buildInstruction(
      { step: 'check', reason: 'run check', agentType: 'skill', agentPrompt: '/check GH-1' },
      STATE_CTX
    );
    assert.equal(instr.delegate.name, 'check');
    assert.match(instr.delegate.howTo, /\$check skill/);
    assert.ok(instr.delegate.howTo.includes(path.join(PLUGIN_ROOT, 'skills', 'check', 'SKILL.md')));
  });

  it('bash delegate is untouched on codex', () => {
    pin('codex');
    const instr = buildInstruction(
      { step: 'ci', reason: 'watch', agentType: 'bash', agentPrompt: 'gh pr checks' },
      STATE_CTX
    );
    assert.deepEqual(instr.delegate, {
      type: 'bash',
      description: 'ci watch',
      command: 'gh pr checks',
    });
  });
});

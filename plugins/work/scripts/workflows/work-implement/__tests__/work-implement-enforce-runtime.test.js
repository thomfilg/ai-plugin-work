'use strict';

/**
 * Dual-runtime tests for work-implement-enforce.js (WP-07):
 *   - payload agent_type is the PRIMARY developer identification (C12)
 *   - codex apply_patch payloads run EVERY parsed target through the gates
 *   - the delegation block text is per-runtime: claude keeps the Task({...})
 *     literal; codex renders inline-persona guidance (C1), and a shell read
 *     of a developer persona file in the rollout satisfies the gate
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'work-implement-enforce.js');

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

function createTestEnv(ticketId, { tddPhase } = {}) {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'wie-rt-'));
  const ticketDir = path.join(tempBase, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, '.work-state.json'),
    JSON.stringify({
      ticketId,
      status: 'in_progress',
      stepStatus: { bootstrap: 'completed', implement: 'in_progress' },
    })
  );
  if (tddPhase) {
    fs.writeFileSync(
      path.join(ticketDir, 'tdd-phase.json'),
      JSON.stringify({ currentPhase: tddPhase, currentCycle: 1, cycles: [] })
    );
  }
  return {
    ticketDir,
    env: { TASKS_BASE: tempBase, TICKET_ID: ticketId },
    cleanup: () => fs.rmSync(tempBase, { recursive: true, force: true }),
  };
}

function writeRollout(records) {
  const file = path.join(
    os.tmpdir(),
    `wie-rt-rollout-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  const meta = {
    type: 'session_meta',
    payload: { id: 's-1', cwd: '/tmp/x', timestamp: '2026-07-07T00:00:00Z' },
  };
  fs.writeFileSync(file, [meta, ...records].map((r) => JSON.stringify(r)).join('\n'));
  return file;
}

function patch(headers) {
  return `*** Begin Patch\n${headers.join('\n')}\n+line\n*** End Patch\n`;
}

describe('work-implement-enforce — dual runtime', () => {
  it('claude: delegation block keeps the Task({...}) literal (characterization)', () => {
    const t = createTestEnv('TEST-WIER-1');
    try {
      const r = runHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: 'src/feature.js', content: 'x' },
        },
        { ...t.env, AGENT_RUNTIME: 'claude' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /\/work-implement requires agent delegation/);
      assert.match(r.stderr, /Task\(\{/);
      assert.match(r.stderr, /subagent_type: "developer-nodejs-tdd"/);
    } finally {
      t.cleanup();
    }
  });

  it('codex: apply_patch delegation block renders inline-persona guidance', () => {
    const t = createTestEnv('TEST-WIER-2');
    try {
      const r = runHook(
        {
          tool_name: 'apply_patch',
          tool_input: { command: patch(['*** Update File: src/feature.js']) },
        },
        { ...t.env, AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /\[work:codex-degraded\] subagents run INLINE/);
      assert.match(r.stderr, /agents\/developer-nodejs-tdd\.md/);
      assert.doesNotMatch(r.stderr, /Task\(\{/);
    } finally {
      t.cleanup();
    }
  });

  it('codex: apply_patch touching only allowed files passes', () => {
    const t = createTestEnv('TEST-WIER-3');
    try {
      const r = runHook(
        {
          tool_name: 'apply_patch',
          tool_input: { command: patch(['*** Update File: docs/README.md']) },
        },
        { ...t.env, AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 0);
    } finally {
      t.cleanup();
    }
  });

  it('codex: multi-target patch blocks when ONE target is tdd-phase.json', () => {
    const t = createTestEnv('TEST-WIER-4');
    try {
      const r = runHook(
        {
          tool_name: 'apply_patch',
          tool_input: {
            command: patch(['*** Update File: docs/README.md', '*** Update File: tdd-phase.json']),
          },
        },
        { ...t.env, AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 2);
      assert.match(r.stderr, /Direct edit of tdd-phase\.json is blocked/);
    } finally {
      t.cleanup();
    }
  });

  it('payload agent_type identifies the developer (both runtimes, no transcript)', () => {
    const t = createTestEnv('TEST-WIER-5', { tddPhase: 'green' });
    try {
      const r = runHook(
        {
          agent_type: 'developer-nodejs-tdd',
          tool_name: 'apply_patch',
          tool_input: { command: patch(['*** Update File: src/feature.js']) },
        },
        { ...t.env, AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 0);
    } finally {
      t.cleanup();
    }
  });

  it('codex: a persona-file shell read in the rollout satisfies the gate', () => {
    const t = createTestEnv('TEST-WIER-6', { tddPhase: 'green' });
    const rollout = writeRollout([
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'c1',
          arguments: JSON.stringify({
            cmd: 'cat /plugin/agents/developer-nodejs-tdd.md',
          }),
        },
      },
    ]);
    try {
      const r = runHook(
        {
          tool_name: 'apply_patch',
          tool_input: { command: patch(['*** Update File: src/feature.js']) },
          transcript_path: rollout,
        },
        { ...t.env, AGENT_RUNTIME: 'codex' }
      );
      assert.equal(r.code, 0);
    } finally {
      t.cleanup();
      fs.rmSync(rollout, { force: true });
    }
  });
});

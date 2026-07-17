'use strict';

/**
 * Table-driven identity-source × decision matrix for lib/agent-identity.js
 * (GH-767, spec "P0 #4").
 *
 * Rows = the six identity sources (orchestrator main session, work agent
 * persona payload, Task-dispatched subagent transcript, headless -p CLI,
 * codex rollout, env-only). Columns = the hook decisions
 * (isRunningInAgent / isDispatchedAgentContext / payloadAgentName).
 * One it() per matrix cell, declared in a data table iterated by the suite.
 *
 * Fixtures follow the writeTranscript tmpdir pattern from
 * agent-detection.test.js.
 *
 * Run: node --test plugins/work/scripts/workflows/lib/__tests__/agent-identity-matrix.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Lazy-tolerant load: while lib/agent-identity.js does not exist yet (RED),
// every test still gets collected and fails on the assertion below instead of
// the whole suite crashing at load time.
let identity = null;
try {
  identity = require('../agent-identity');
} catch {
  identity = null;
}

function api(name) {
  assert.ok(identity, 'lib/agent-identity.js is missing — the entry point does not exist yet');
  const fn = identity[name];
  assert.equal(typeof fn, 'function', `agent-identity must export ${name} as a function`);
  return fn;
}

const isRunningInAgent = (...args) => api('isRunningInAgent')(...args);
const isDispatchedAgentContext = (...args) => api('isDispatchedAgentContext')(...args);
const payloadAgentName = (...args) => api('payloadAgentName')(...args);
const dispatchTargetAgent = (...args) => api('dispatchTargetAgent')(...args);
const envAgentName = (...args) => api('envAgentName')(...args);
const classifyIdentity = (...args) => api('classifyIdentity')(...args);
const activeAgentDetectionPayload = (...args) => api('activeAgentDetectionPayload')(...args);

// Transcripts live in a private mode-0700 tmpdir (unpredictable name) so a
// predictable filename cannot be exploited via a symlink/race attack.
const TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-identity-'));
process.on('exit', () => {
  try {
    fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// Build a claude JSONL transcript file from line objects; returns its path.
function writeTranscript(lines) {
  const tmp = path.join(
    TRANSCRIPT_DIR,
    `matrix-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  fs.writeFileSync(tmp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return tmp;
}

// Build a codex rollout transcript (session_meta + response_item records).
function writeRollout(records) {
  const tmp = path.join(
    TRANSCRIPT_DIR,
    `rollout-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  const meta = {
    type: 'session_meta',
    payload: { id: 's-1', cwd: '/tmp/x', timestamp: '2026-07-17T00:00:00Z' },
  };
  fs.writeFileSync(tmp, [meta, ...records].map((r) => JSON.stringify(r)).join('\n'));
  return tmp;
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

// ─── Env hygiene: every test runs with a clean identity env ─────────────────

const SAVED_ENV_KEYS = ['CLAUDE_CURRENT_AGENT', 'CLAUDE_AGENT_TYPE', 'ENFORCE_HOOK_DEBUG'];
const savedEnv = {};

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

// ─── 1.1 Module surface: exports and accessor payload shapes ────────────────

describe('agent-identity module surface', () => {
  const EXPECTED_EXPORTS = [
    // re-exports of the existing detection legs
    'isRunningInAgent',
    'isDispatchedAgentContext',
    'isSubagentContext',
    'isSubagentFromInitialPrompt',
    'normalizeAgentName',
    'matchesAlias',
    'readInitialMarkers',
    // new accessors
    'payloadAgentName',
    'dispatchTargetAgent',
    'envAgentName',
    'classifyIdentity',
    'activeAgentDetectionPayload',
  ];

  for (const name of EXPECTED_EXPORTS) {
    it(`exports ${name} as a function`, () => {
      assert.ok(identity, 'lib/agent-identity.js is missing — the entry point does not exist yet');
      assert.equal(typeof identity[name], 'function', `${name} must be exported as a function`);
    });
  }
});

describe('Payload agent_type is the highest-precedence self-identity signal', () => {
  it('payloadAgentName reads agent_type first, normalized', () => {
    assert.equal(
      payloadAgentName({ agent_type: 'Work-Workflow:Quality-Checker' }),
      'quality-checker'
    );
  });

  it('payloadAgentName prefers agent_type over agent_name and subagent_type', () => {
    assert.equal(
      payloadAgentName({
        agent_type: 'quality-checker',
        agent_name: 'pr-generator',
        subagent_type: 'commit-writer',
      }),
      'quality-checker'
    );
  });

  it('payloadAgentName falls back to legacy agent_name', () => {
    assert.equal(payloadAgentName({ agent_name: 'work-workflow:pr-generator' }), 'pr-generator');
  });

  it('payloadAgentName falls back to top-level subagent_type last', () => {
    assert.equal(payloadAgentName({ subagent_type: 'Commit-Writer' }), 'commit-writer');
  });

  it("payloadAgentName returns '' for an empty payload", () => {
    assert.equal(payloadAgentName({}), '');
  });

  it("payloadAgentName returns '' for null/undefined payloads", () => {
    assert.equal(payloadAgentName(null), '');
    assert.equal(payloadAgentName(undefined), '');
  });

  it("payloadAgentName returns '' for malformed (non-string) identity fields", () => {
    assert.equal(payloadAgentName({ agent_type: 42 }), '');
    assert.equal(payloadAgentName({ agent_type: { nested: true } }), '');
  });

  it('payload agent_type wins even when env names a different agent', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'pr-generator';
    const result = classifyIdentity(null, ['quality-checker'], {
      agent_type: 'quality-checker',
    });
    assert.equal(result.decision, true);
    assert.equal(result.signal, 'payload');
  });
});

describe('Dispatch target is never conflated with self-identity', () => {
  it('dispatchTargetAgent returns the normalized subagent_type of the tool input', () => {
    assert.equal(
      dispatchTargetAgent({ subagent_type: 'Work-Workflow:Quality-Checker' }),
      'quality-checker'
    );
  });

  it("dispatchTargetAgent returns '' for null/missing/malformed tool input", () => {
    assert.equal(dispatchTargetAgent(null), '');
    assert.equal(dispatchTargetAgent(undefined), '');
    assert.equal(dispatchTargetAgent({}), '');
    assert.equal(dispatchTargetAgent({ subagent_type: 7 }), '');
  });

  it('payloadAgentName ignores tool_input.subagent_type (dispatch target, not self)', () => {
    assert.equal(
      payloadAgentName({ tool_name: 'Task', tool_input: { subagent_type: 'quality-checker' } }),
      ''
    );
  });

  it('activeAgentDetectionPayload strips tool_input.subagent_type', () => {
    const hookData = {
      tool_name: 'Bash',
      tool_input: { subagent_type: 'quality-checker', command: 'ls' },
      transcript_path: '/tmp/nope.jsonl',
    };
    const stripped = activeAgentDetectionPayload(hookData);
    assert.equal(stripped.tool_input.subagent_type, undefined);
    assert.equal(stripped.tool_input.command, 'ls');
    // original payload untouched
    assert.equal(hookData.tool_input.subagent_type, 'quality-checker');
  });

  it('activeAgentDetectionPayload returns the payload unchanged when no subagent_type', () => {
    const hookData = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    assert.equal(activeAgentDetectionPayload(hookData), hookData);
  });

  it('a parent dispatching an agent is NOT identified as that agent', () => {
    const hookData = { tool_name: 'Task', tool_input: { subagent_type: 'quality-checker' } };
    assert.equal(
      isRunningInAgent(null, ['quality-checker'], activeAgentDetectionPayload(hookData)),
      false
    );
  });
});

describe('envAgentName', () => {
  it('returns the normalized CLAUDE_CURRENT_AGENT value', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'Work-Workflow:Quality-Checker';
    assert.equal(envAgentName(), 'quality-checker');
  });

  it("returns '' when CLAUDE_CURRENT_AGENT is unset", () => {
    assert.equal(envAgentName(), '');
  });
});

// ─── 1.2 The identity-source × decision matrix (spec "P0 #4") ───────────────

const MATCH_ALIASES = ['quality-checker'];
const MISMATCH_ALIASES = ['pr-generator'];

/**
 * Six identity sources. Each row declares fixture builders and the expected
 * truth value for every decision column (spec "P0 #4" table).
 */
const MATRIX = [
  {
    source: 'Orchestrator main session yields the null identity everywhere',
    fixture: () => ({ transcriptPath: null, hookData: {} }),
    expected: {
      isRunningInAgent: false,
      isRunningInAgentMismatch: false,
      isDispatchedAgentContext: false,
      payloadAgentName: '',
      classifySignal: 'none',
    },
  },
  {
    source: 'Payload agent_type is the highest-precedence self-identity signal',
    fixture: () => ({
      transcriptPath: null,
      hookData: { agent_type: 'work-workflow:quality-checker' },
    }),
    expected: {
      isRunningInAgent: true,
      isRunningInAgentMismatch: false,
      isDispatchedAgentContext: true,
      payloadAgentName: 'quality-checker',
      classifySignal: 'payload',
    },
  },
  {
    source: 'Task-dispatched subagent identified by attributionAgent marker',
    fixture: () => ({
      transcriptPath: writeTranscript([
        {
          type: 'user',
          isSidechain: true,
          attributionAgent: 'quality-checker',
          message: { role: 'user', content: 'Run the quality checks for GH-767.' },
        },
      ]),
      hookData: {},
    }),
    expected: {
      isRunningInAgent: true,
      isRunningInAgentMismatch: false,
      isDispatchedAgentContext: true,
      payloadAgentName: '',
      classifySignal: 'structural-marker',
    },
  },
  {
    source: 'Headless -p CLI transcript whose prompt mentions agent names',
    fixture: () => ({
      transcriptPath: writeTranscript([
        {
          type: 'user',
          message: {
            role: 'user',
            content: 'use the quality-checker agent and then the pr-generator agent',
          },
        },
      ]),
      hookData: {},
    }),
    expected: {
      isRunningInAgent: false,
      isRunningInAgentMismatch: false,
      isDispatchedAgentContext: false,
      payloadAgentName: '',
      classifySignal: 'none',
    },
  },
  {
    source: 'Codex rollout transcript routes through the dual-runtime leg',
    fixture: () => ({
      transcriptPath: writeRollout([spawnAgentCall('c1', 'quality-checker')]),
      hookData: {},
    }),
    expected: {
      isRunningInAgent: true,
      isRunningInAgentMismatch: false,
      isDispatchedAgentContext: false,
      payloadAgentName: '',
      classifySignal: 'codex-rollout',
    },
  },
  {
    source: 'Env-only CLAUDE_CURRENT_AGENT (documented legacy, spoofable)',
    env: { CLAUDE_CURRENT_AGENT: 'work-workflow:quality-checker' },
    fixture: () => ({ transcriptPath: null, hookData: {} }),
    expected: {
      isRunningInAgent: true,
      isRunningInAgentMismatch: false,
      isDispatchedAgentContext: true,
      payloadAgentName: '',
      classifySignal: 'env',
    },
  },
];

function applyRowEnv(row) {
  for (const [key, value] of Object.entries(row.env || {})) {
    process.env[key] = value;
  }
}

describe('identity-source × decision matrix', () => {
  for (const row of MATRIX) {
    describe(row.source, () => {
      it(`isRunningInAgent(quality-checker) → ${row.expected.isRunningInAgent}`, () => {
        applyRowEnv(row);
        const { transcriptPath, hookData } = row.fixture();
        assert.equal(
          isRunningInAgent(transcriptPath, MATCH_ALIASES, hookData),
          row.expected.isRunningInAgent
        );
      });

      it(`isRunningInAgent(pr-generator alias mismatch) → ${row.expected.isRunningInAgentMismatch}`, () => {
        applyRowEnv(row);
        const { transcriptPath, hookData } = row.fixture();
        assert.equal(
          isRunningInAgent(transcriptPath, MISMATCH_ALIASES, hookData),
          row.expected.isRunningInAgentMismatch
        );
      });

      it(`isDispatchedAgentContext → ${row.expected.isDispatchedAgentContext}`, () => {
        applyRowEnv(row);
        const { transcriptPath, hookData } = row.fixture();
        assert.equal(
          isDispatchedAgentContext(transcriptPath, hookData),
          row.expected.isDispatchedAgentContext
        );
      });

      it(`payloadAgentName → '${row.expected.payloadAgentName}'`, () => {
        applyRowEnv(row);
        const { hookData } = row.fixture();
        assert.equal(payloadAgentName(hookData), row.expected.payloadAgentName);
      });
    });
  }
});

// ─── 1.3 classifyIdentity: deciding-signal shape + debug observability ──────

function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return typeof original === 'function' ? true : original.call(process.stderr, chunk, ...rest);
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines.filter((l) => l.startsWith('[agent-identity]'));
}

describe('classifyIdentity — deciding signal per matrix row', () => {
  for (const row of MATRIX) {
    it(`${row.source}: { decision: ${row.expected.isRunningInAgent}, signal: '${row.expected.classifySignal}' }`, () => {
      applyRowEnv(row);
      const { transcriptPath, hookData } = row.fixture();
      const result = classifyIdentity(transcriptPath, MATCH_ALIASES, hookData);
      assert.equal(typeof result, 'object');
      assert.equal(result.decision, row.expected.isRunningInAgent);
      assert.equal(result.signal, row.expected.classifySignal);
    });
  }

  it('with ENFORCE_HOOK_DEBUG=1 each classification emits exactly one [agent-identity] stderr line', () => {
    for (const row of MATRIX) {
      applyRowEnv(row);
      const { transcriptPath, hookData } = row.fixture();
      process.env.ENFORCE_HOOK_DEBUG = '1';
      const debugLines = captureStderr(() => {
        classifyIdentity(transcriptPath, MATCH_ALIASES, hookData);
      });
      delete process.env.ENFORCE_HOOK_DEBUG;
      assert.equal(
        debugLines.length,
        1,
        `${row.source}: expected exactly one [agent-identity] line, got ${debugLines.length}`
      );
      assert.match(
        debugLines[0],
        new RegExp(`^\\[agent-identity\\] ${row.expected.classifySignal}:`),
        `${row.source}: line must name the deciding signal`
      );
    }
  });

  it('without ENFORCE_HOOK_DEBUG the [agent-identity] channel is silent', () => {
    for (const row of MATRIX) {
      applyRowEnv(row);
      const { transcriptPath, hookData } = row.fixture();
      const debugLines = captureStderr(() => {
        classifyIdentity(transcriptPath, MATCH_ALIASES, hookData);
      });
      assert.equal(debugLines.length, 0, `${row.source}: expected silence without the env var`);
      // Reset env between rows (env-only row sets CLAUDE_CURRENT_AGENT).
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
  });
});

// ─── 1.4 Hook-author pointer paragraph in plugins/work/CLAUDE.md ────────────

describe('hook-author pointer paragraph in plugins/work/CLAUDE.md', () => {
  const claudeMdPath = path.resolve(__dirname, '..', '..', '..', '..', 'CLAUDE.md');

  it('CLAUDE.md points hook authors at the agent-identity module contract', () => {
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    assert.match(content, /agent-identity/, 'CLAUDE.md must mention agent-identity');
    assert.match(content, /payloadAgentName/, 'paragraph must name payloadAgentName');
    assert.match(content, /dispatchTargetAgent/, 'paragraph must name dispatchTargetAgent');
    assert.match(content, /envAgentName/, 'paragraph must name envAgentName');
  });
});

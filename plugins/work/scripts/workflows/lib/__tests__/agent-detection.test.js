/**
 * Tests for lib/agent-detection.js — normalizeAgentName and isRunningInAgent enhancements
 *
 * Run: node --test lib/__tests__/agent-detection.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeAgentName, isRunningInAgent } = require('../agent-detection');

// Transcripts are written inside a private, permission-restricted directory
// (fs.mkdtempSync → mode 0700, unpredictable name) rather than directly in the
// world-writable OS temp dir, so a predictable filename cannot be exploited via
// a symlink/race attack (CodeQL js/insecure-temporary-file).
const TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-detect-'));
process.on('exit', () => {
  try {
    fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// Build a JSONL transcript file from an array of line objects; returns its path.
function writeTranscript(lines) {
  const tmp = path.join(
    TRANSCRIPT_DIR,
    `initprompt-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  fs.writeFileSync(tmp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return tmp;
}

// ─── normalizeAgentName ──────────────────────────────────────────────────────

describe('normalizeAgentName', () => {
  it('returns bare name unchanged (lowercased)', () => {
    assert.equal(normalizeAgentName('quality-checker'), 'quality-checker');
  });

  it('strips namespace prefix', () => {
    assert.equal(normalizeAgentName('work-workflow:quality-checker'), 'quality-checker');
  });

  it('lowercases mixed-case input', () => {
    assert.equal(normalizeAgentName('Quality-Checker'), 'quality-checker');
  });

  it('handles prefixed mixed-case', () => {
    assert.equal(normalizeAgentName('Work-Workflow:Quality-Checker'), 'quality-checker');
  });

  it('returns empty string for null', () => {
    assert.equal(normalizeAgentName(null), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(normalizeAgentName(undefined), '');
  });

  it('returns empty string for empty string', () => {
    assert.equal(normalizeAgentName(''), '');
  });
});

// ─── isRunningInAgent — env var detection ────────────────────────────────────

describe('isRunningInAgent — CLAUDE_CURRENT_AGENT env var', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    savedEnv.ENFORCE_HOOK_DEBUG = process.env.ENFORCE_HOOK_DEBUG;
    delete process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.ENFORCE_HOOK_DEBUG;
  });

  afterEach(() => {
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
    if (savedEnv.ENFORCE_HOOK_DEBUG !== undefined) {
      process.env.ENFORCE_HOOK_DEBUG = savedEnv.ENFORCE_HOOK_DEBUG;
    } else {
      delete process.env.ENFORCE_HOOK_DEBUG;
    }
  });

  it('matches bare agent name from env var', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'quality-checker';
    assert.ok(isRunningInAgent(null, ['quality-checker']));
  });

  it('matches prefixed env var against bare alias (normalization)', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'work-workflow:quality-checker';
    assert.ok(isRunningInAgent(null, ['quality-checker']));
  });

  it('matches bare env var against prefixed alias (normalization)', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'quality-checker';
    assert.ok(isRunningInAgent(null, ['work-workflow:quality-checker']));
  });

  it('returns false when env var does not match any alias', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'other-agent';
    // Need a non-existent transcript so other strategies also fail
    assert.ok(!isRunningInAgent('/nonexistent/transcript.json', ['quality-checker']));
  });
});

// ─── isRunningInAgent — hookData.tool_input.subagent_type ────────────────────

describe('isRunningInAgent — hookData subagent_type', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    savedEnv.ENFORCE_HOOK_DEBUG = process.env.ENFORCE_HOOK_DEBUG;
    delete process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.ENFORCE_HOOK_DEBUG;
  });

  afterEach(() => {
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
    if (savedEnv.ENFORCE_HOOK_DEBUG !== undefined) {
      process.env.ENFORCE_HOOK_DEBUG = savedEnv.ENFORCE_HOOK_DEBUG;
    } else {
      delete process.env.ENFORCE_HOOK_DEBUG;
    }
  });

  it('matches subagent_type from hookData', () => {
    const hookData = { tool_input: { subagent_type: 'quality-checker' } };
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['quality-checker'], hookData));
  });

  it('matches prefixed subagent_type against bare alias (normalization)', () => {
    const hookData = { tool_input: { subagent_type: 'work-workflow:quality-checker' } };
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['quality-checker'], hookData));
  });

  it('returns false when subagent_type does not match', () => {
    const hookData = { tool_input: { subagent_type: 'other-agent' } };
    assert.ok(!isRunningInAgent('/nonexistent/transcript.json', ['quality-checker'], hookData));
  });
});

// ─── isRunningInAgent — returns false when all strategies fail ────────────────

describe('isRunningInAgent — fallback', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.CLAUDE_CURRENT_AGENT;
  });

  afterEach(() => {
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
  });

  it('returns false when no env var, no hookData, and no transcript match', () => {
    assert.ok(!isRunningInAgent('/nonexistent/transcript.json', ['quality-checker'], {}));
  });
});

// ─── Frontmatter detection ──────────────────────────────────────────────────

describe('isRunningInAgent — frontmatter detection', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const savedAgent = process.env.CLAUDE_CURRENT_AGENT;

  beforeEach(() => {
    delete process.env.CLAUDE_CURRENT_AGENT;
  });
  afterEach(() => {
    if (savedAgent !== undefined) process.env.CLAUDE_CURRENT_AGENT = savedAgent;
    else delete process.env.CLAUDE_CURRENT_AGENT;
  });

  it('matches prefixed frontmatter name against bare alias', () => {
    const tmp = path.join(os.tmpdir(), `agent-detect-fm-${process.pid}.txt`);
    fs.writeFileSync(tmp, 'name: work-workflow:quality-checker\n');
    try {
      assert.ok(isRunningInAgent(tmp, ['quality-checker']));
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('matches bare frontmatter name against bare alias', () => {
    const tmp = path.join(os.tmpdir(), `agent-detect-fm2-${process.pid}.txt`);
    fs.writeFileSync(tmp, 'name: quality-checker\n');
    try {
      assert.ok(isRunningInAgent(tmp, ['quality-checker']));
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// ─── Debug logging ───────────────────────────────────────────────────────────

describe('isRunningInAgent — debug logging', () => {
  const savedEnv = {};
  let stderrOutput = '';
  let originalWrite;

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    savedEnv.ENFORCE_HOOK_DEBUG = process.env.ENFORCE_HOOK_DEBUG;
    delete process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.ENFORCE_HOOK_DEBUG;
    stderrOutput = '';
    originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
    if (savedEnv.ENFORCE_HOOK_DEBUG !== undefined) {
      process.env.ENFORCE_HOOK_DEBUG = savedEnv.ENFORCE_HOOK_DEBUG;
    } else {
      delete process.env.ENFORCE_HOOK_DEBUG;
    }
  });

  it('emits debug log when ENFORCE_HOOK_DEBUG is set and env var matches', () => {
    process.env.ENFORCE_HOOK_DEBUG = '1';
    process.env.CLAUDE_CURRENT_AGENT = 'quality-checker';
    isRunningInAgent(null, ['quality-checker']);
    assert.ok(stderrOutput.includes('[agent-detection]'));
    assert.ok(stderrOutput.includes('matched'));
  });

  it('does not emit debug log when ENFORCE_HOOK_DEBUG is not set', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'quality-checker';
    isRunningInAgent(null, ['quality-checker']);
    assert.equal(stderrOutput, '');
  });
});

// ─── isRunningInAgent — hookData.agent_type (Primary-B) ──────────────────────

describe('isRunningInAgent — hookData.agent_type', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    savedEnv.ENFORCE_HOOK_DEBUG = process.env.ENFORCE_HOOK_DEBUG;
    delete process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.ENFORCE_HOOK_DEBUG;
  });

  afterEach(() => {
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
    if (savedEnv.ENFORCE_HOOK_DEBUG !== undefined) {
      process.env.ENFORCE_HOOK_DEBUG = savedEnv.ENFORCE_HOOK_DEBUG;
    } else {
      delete process.env.ENFORCE_HOOK_DEBUG;
    }
  });

  it('matches exact agent_type from hookData', () => {
    const hookData = { agent_type: 'code-checker' };
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData));
  });

  it('matches agent_type with namespace prefix via normalization', () => {
    const hookData = { agent_type: 'work-workflow:code-checker' };
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData));
  });

  it('returns false when agent_type does not match any alias', () => {
    const hookData = { agent_type: 'other-agent' };
    assert.ok(!isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData));
  });

  it('agent_type takes precedence over tool_input.subagent_type', () => {
    // agent_type matches, subagent_type does not — should still match
    const hookData = {
      agent_type: 'code-checker',
      tool_input: { subagent_type: 'wrong-agent' },
    };
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData));
  });

  it('CLAUDE_CURRENT_AGENT env var takes precedence over agent_type when it matches', () => {
    // env var matches — returns true without ever checking agent_type
    process.env.CLAUDE_CURRENT_AGENT = 'code-checker';
    const hookData = { agent_type: 'wrong-agent' };
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData));
  });

  it('falls through to agent_type when CLAUDE_CURRENT_AGENT does not match', () => {
    // env var is 'other-agent' which doesn't match ['code-checker']
    // so it falls through to agent_type which is 'code-checker' — matches
    process.env.CLAUDE_CURRENT_AGENT = 'other-agent';
    const hookData = { agent_type: 'code-checker' };
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData));
  });

  it('agent_type with different casing matches via normalization', () => {
    const hookData = { agent_type: 'Code-Checker' };
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData));
  });
});

// ─── isRunningInAgent — debug logging for agent_type ─────────────────────────

describe('isRunningInAgent — debug logging for agent_type', () => {
  const savedEnv = {};
  let stderrOutput = '';
  let originalWrite;

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    savedEnv.ENFORCE_HOOK_DEBUG = process.env.ENFORCE_HOOK_DEBUG;
    delete process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.ENFORCE_HOOK_DEBUG;
    stderrOutput = '';
    originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
    if (savedEnv.ENFORCE_HOOK_DEBUG !== undefined) {
      process.env.ENFORCE_HOOK_DEBUG = savedEnv.ENFORCE_HOOK_DEBUG;
    } else {
      delete process.env.ENFORCE_HOOK_DEBUG;
    }
  });

  it('emits debug log for agent_type match', () => {
    process.env.ENFORCE_HOOK_DEBUG = '1';
    const hookData = { agent_type: 'code-checker' };
    isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData);
    assert.ok(stderrOutput.includes('[agent-detection]'));
    assert.ok(stderrOutput.includes('matched agent_type'));
  });

  it('emits debug log for agent_type miss', () => {
    process.env.ENFORCE_HOOK_DEBUG = '1';
    const hookData = { agent_type: 'other-agent' };
    isRunningInAgent('/nonexistent/transcript.json', ['code-checker'], hookData);
    assert.ok(stderrOutput.includes('[agent-detection]'));
    assert.ok(stderrOutput.includes('no match for agent_type'));
  });
});

// ─── 1.1 — Authoritative attributionAgent detection ──────────────────────────

describe('isSubagentFromInitialPrompt — attributionAgent authority', () => {
  const savedEnv = {};
  const created = [];

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    savedEnv.ENFORCE_HOOK_DEBUG = process.env.ENFORCE_HOOK_DEBUG;
    delete process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.ENFORCE_HOOK_DEBUG;
  });

  afterEach(() => {
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
    if (savedEnv.ENFORCE_HOOK_DEBUG !== undefined) {
      process.env.ENFORCE_HOOK_DEBUG = savedEnv.ENFORCE_HOOK_DEBUG;
    } else {
      delete process.env.ENFORCE_HOOK_DEBUG;
    }
    while (created.length) {
      const p = created.pop();
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  it('detects a sidechain subagent by its attributionAgent field', () => {
    const tmp = writeTranscript([
      {
        type: 'user',
        isSidechain: true,
        attributionAgent: 'work-workflow:commit-writer',
        message: { content: 'stage and commit the changes' },
      },
    ]);
    created.push(tmp);
    assert.ok(isRunningInAgent(tmp, ['commit-writer']));
  });

  it('does NOT match when attributionAgent is a different agent', () => {
    const tmp = writeTranscript([
      {
        type: 'user',
        isSidechain: true,
        attributionAgent: 'work-workflow:quality-checker',
        message: { content: 'run the quality gate' },
      },
    ]);
    created.push(tmp);
    assert.ok(!isRunningInAgent(tmp, ['commit-writer']));
  });

  it('attributionAgent overrides conflicting prose (matches the attributed agent)', () => {
    const tmp = writeTranscript([
      {
        type: 'user',
        isSidechain: true,
        attributionAgent: 'work-workflow:commit-writer',
        message: { content: 'please dispatch the quality-checker agent' },
      },
    ]);
    created.push(tmp);
    assert.ok(isRunningInAgent(tmp, ['commit-writer']));
  });

  it('attributionAgent overrides conflicting prose (not the prose-named agent)', () => {
    const tmp = writeTranscript([
      {
        type: 'user',
        isSidechain: true,
        attributionAgent: 'work-workflow:commit-writer',
        message: { content: 'please dispatch the quality-checker agent' },
      },
    ]);
    created.push(tmp);
    assert.ok(!isRunningInAgent(tmp, ['quality-checker']));
  });
});

// ─── 1.2 — Name-substring fallback gated behind isSidechain === true ──────────

describe('isSubagentFromInitialPrompt — isSidechain gate', () => {
  const savedEnv = {};
  const created = [];

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.CLAUDE_CURRENT_AGENT;
  });

  afterEach(() => {
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
    while (created.length) {
      const p = created.pop();
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  it('main session naming an agent (no isSidechain, no attributionAgent) is NOT detected', () => {
    const tmp = writeTranscript([
      { type: 'user', message: { content: 'dispatch the commit-writer agent' } },
    ]);
    created.push(tmp);
    assert.ok(!isRunningInAgent(tmp, ['commit-writer']));
  });

  it('sidechain naming an agent (isSidechain true, no attributionAgent) IS detected', () => {
    const tmp = writeTranscript([
      { type: 'user', isSidechain: true, message: { content: 'dispatch the commit-writer agent' } },
    ]);
    created.push(tmp);
    assert.ok(isRunningInAgent(tmp, ['commit-writer']));
  });

  it('same prompt with isSidechain false returns false again', () => {
    const tmp = writeTranscript([
      {
        type: 'user',
        isSidechain: false,
        message: { content: 'dispatch the commit-writer agent' },
      },
    ]);
    created.push(tmp);
    assert.ok(!isRunningInAgent(tmp, ['commit-writer']));
  });
});

// ─── 1.3 — Debug logging of matched marker; fail-open & env precedence ────────

describe('isSubagentFromInitialPrompt — marker debug logging & fail-open', () => {
  const savedEnv = {};
  const created = [];
  let stderrOutput = '';
  let originalWrite;

  beforeEach(() => {
    savedEnv.CLAUDE_CURRENT_AGENT = process.env.CLAUDE_CURRENT_AGENT;
    savedEnv.ENFORCE_HOOK_DEBUG = process.env.ENFORCE_HOOK_DEBUG;
    delete process.env.CLAUDE_CURRENT_AGENT;
    delete process.env.ENFORCE_HOOK_DEBUG;
    stderrOutput = '';
    originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk;
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    if (savedEnv.CLAUDE_CURRENT_AGENT !== undefined) {
      process.env.CLAUDE_CURRENT_AGENT = savedEnv.CLAUDE_CURRENT_AGENT;
    } else {
      delete process.env.CLAUDE_CURRENT_AGENT;
    }
    if (savedEnv.ENFORCE_HOOK_DEBUG !== undefined) {
      process.env.ENFORCE_HOOK_DEBUG = savedEnv.ENFORCE_HOOK_DEBUG;
    } else {
      delete process.env.ENFORCE_HOOK_DEBUG;
    }
    while (created.length) {
      const p = created.pop();
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  it('emits a [agent-detection] debug line naming the matched structural marker', () => {
    process.env.ENFORCE_HOOK_DEBUG = '1';
    const tmp = writeTranscript([
      {
        type: 'user',
        isSidechain: true,
        attributionAgent: 'work-workflow:commit-writer',
        message: { content: 'stage and commit' },
      },
    ]);
    created.push(tmp);
    isRunningInAgent(tmp, ['commit-writer']);
    assert.ok(stderrOutput.includes('[agent-detection]'));
    assert.ok(
      stderrOutput.includes('attributionAgent') || stderrOutput.includes('isSidechain'),
      `expected a marker name in debug output, got: ${stderrOutput}`
    );
  });

  it('returns false without throwing for a missing/unreadable transcript', () => {
    assert.doesNotThrow(() => {
      assert.ok(!isRunningInAgent('/nonexistent/transcript.json', ['commit-writer']));
    });
  });

  it('env var short-circuits before any transcript scan (nonexistent transcript)', () => {
    process.env.CLAUDE_CURRENT_AGENT = 'commit-writer';
    assert.ok(isRunningInAgent('/nonexistent/transcript.json', ['commit-writer']));
  });
});

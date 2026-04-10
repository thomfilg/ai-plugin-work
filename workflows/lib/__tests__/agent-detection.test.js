/**
 * Tests for lib/agent-detection.js — normalizeAgentName and isRunningInAgent enhancements
 *
 * Run: node --test lib/__tests__/agent-detection.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAgentName, isRunningInAgent } = require('../agent-detection');

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

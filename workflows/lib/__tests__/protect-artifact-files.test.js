/**
 * Tests for lib/protect-artifact-files.js
 *
 * Run: node --test lib/__tests__/protect-artifact-files.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createArtifactProtector, matchesRule } = require('../protect-artifact-files');

// ─── matchesRule ─────────────────────────────────────────────────────────────

describe('matchesRule', () => {
  it('matches exact basename', () => {
    assert.ok(matchesRule('brief.md', { basename: 'brief.md', step: 'brief' }));
  });

  it('rejects non-matching basename', () => {
    assert.ok(!matchesRule('spec.md', { basename: 'brief.md', step: 'brief' }));
  });

  it('matches pattern', () => {
    assert.ok(matchesRule('qa-app.check.md', { pattern: /^qa-.*\.check\.md$/, step: 'check' }));
  });

  it('rejects non-matching pattern', () => {
    assert.ok(!matchesRule('brief.md', { pattern: /^qa-.*\.check\.md$/, step: 'check' }));
  });

  it('returns false when no basename or pattern', () => {
    assert.ok(!matchesRule('brief.md', { step: 'brief' }));
  });
});

// ─── createArtifactProtector ────────────────────────────────────────────────

describe('createArtifactProtector', () => {
  const TICKET = 'TEST-123';

  function makeProtector(overrides = {}) {
    return createArtifactProtector({
      artifacts: [
        { basename: 'brief.md', step: 'brief' },
        { basename: 'spec.md', step: 'spec', agents: ['spec-writer'] },
        { pattern: /\.check\.md$/, step: 'check', agents: ['code-checker', 'qa-tester'] },
      ],
      getStepInProgress: () => overrides.currentStep || null,
      isRunningInAgent: overrides.isRunningInAgent || (() => true),
      getTicketId: () => overrides.ticketId || TICKET,
      ...overrides,
    });
  }

  // ── Non-write tools ──

  it('allows non-write tools (Bash)', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: 'echo hello' });
    assert.equal(result.blocked, false);
  });

  it('allows non-write tools (Read)', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Read', { file_path: `/tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, false);
  });

  // ── No file path ──

  it('allows Write with empty file_path', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Write', { file_path: '' });
    assert.equal(result.blocked, false);
  });

  // ── Non-matching file ──

  it('allows writing unprotected files', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/notes.md` });
    assert.equal(result.blocked, false);
  });

  // ── No ticket context ──

  it('allows when no ticket ID (fail-open)', () => {
    const p = makeProtector({ currentStep: 'brief', getTicketId: () => null });
    const result = p.check('Write', { file_path: '/tasks/TEST-123/brief.md' });
    assert.equal(result.blocked, false);
  });

  // ── File outside ticket folder ──

  it('allows writing protected file outside ticket folder', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Write', { file_path: '/other/brief.md' });
    assert.equal(result.blocked, false);
  });

  // ── Step gating ──

  it('blocks brief.md when step is NOT brief', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
    assert.ok(result.message.includes('brief'));
  });

  it('allows brief.md when step IS brief', () => {
    const p = makeProtector({ currentStep: 'brief' });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, false);
  });

  it('blocks Edit to brief.md outside step', () => {
    const p = makeProtector({ currentStep: 'check' });
    const result = p.check('Edit', { file_path: `/tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
  });

  it('blocks MultiEdit to brief.md outside step', () => {
    const p = makeProtector({ currentStep: 'check' });
    const result = p.check('MultiEdit', { file_path: `/tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, true);
  });

  // ── Agent gating ──

  it('blocks spec.md when correct step but wrong agent', () => {
    const p = makeProtector({
      currentStep: 'spec',
      isRunningInAgent: () => false,
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/spec.md` });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'agent');
    assert.ok(result.message.includes('spec-writer'));
  });

  it('allows spec.md when correct step AND correct agent', () => {
    const p = makeProtector({
      currentStep: 'spec',
      isRunningInAgent: () => true,
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/spec.md` });
    assert.equal(result.blocked, false);
  });

  // ── Pattern matching (check reports) ──

  it('blocks code-review.check.md outside check step', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/code-review.check.md` });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
  });

  it('blocks qa-app.check.md when correct step but wrong agent', () => {
    const p = makeProtector({
      currentStep: 'check',
      isRunningInAgent: () => false,
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/qa-app.check.md` });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'agent');
    assert.ok(result.message.includes('code-checker'));
    assert.ok(result.message.includes('qa-tester'));
  });

  it('allows check report when correct step AND correct agent', () => {
    const p = makeProtector({
      currentStep: 'check',
      isRunningInAgent: () => true,
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/tests.check.md` });
    assert.equal(result.blocked, false);
  });

  // ── No agents specified (brief.md has no agents) ──

  it('allows brief.md from any agent when step is correct (no agents defined)', () => {
    const p = makeProtector({
      currentStep: 'brief',
      isRunningInAgent: () => false, // would block if agents were checked
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, false); // no agents defined → no agent check
  });

  // ── hookData passthrough ──

  it('passes transcript_path from hookData to isRunningInAgent', () => {
    let capturedPath = null;
    let capturedAgents = null;
    const p = makeProtector({
      currentStep: 'spec',
      isRunningInAgent: (tp, agents) => { capturedPath = tp; capturedAgents = agents; return true; },
    });
    p.check('Write', { file_path: `/tasks/${TICKET}/spec.md` }, { transcript_path: '/tmp/transcript.json' });
    assert.equal(capturedPath, '/tmp/transcript.json');
    assert.deepEqual(capturedAgents, ['spec-writer']);
  });

  it('passes full hookData as third arg to isRunningInAgent', () => {
    let capturedHookData = null;
    const p = makeProtector({
      currentStep: 'spec',
      isRunningInAgent: (tp, agents, hd) => { capturedHookData = hd; return true; },
    });
    const hookData = {
      transcript_path: '/tmp/transcript.json',
      tool_input: { subagent_type: 'spec-writer' },
    };
    p.check('Write', { file_path: `/tasks/${TICKET}/spec.md` }, hookData);
    assert.deepEqual(capturedHookData, hookData);
  });

  // ── Step message includes current step ──

  it('includes current step in block message', () => {
    const p = makeProtector({ currentStep: 'pr' });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/brief.md` });
    assert.ok(result.message.includes('pr'));
  });

  it('shows (none) when no step in progress', () => {
    const p = makeProtector({ currentStep: null });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/brief.md` });
    assert.ok(result.message.includes('(none)'));
  });

  // ── Bash write vector ──

  it('blocks Bash redirect to brief.md outside step', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: `cat > /tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
  });

  it('blocks Bash tee to spec.md outside step', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: `echo "test" | tee /tasks/${TICKET}/spec.md` });
    assert.equal(result.blocked, true);
  });

  it('blocks Bash cp to check report outside step', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: `cp /tmp/report.md /tasks/${TICKET}/tests.check.md` });
    assert.equal(result.blocked, true);
  });

  it('blocks Bash sed -i on brief.md outside step', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: `sed -i 's/old/new/' /tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, true);
  });

  it('blocks Bash node writeFileSync to brief.md outside step', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: `node -e "require('fs').writeFileSync('/tasks/${TICKET}/brief.md', 'hacked')"` });
    assert.equal(result.blocked, true);
  });

  it('allows Bash redirect to brief.md when step IS brief', () => {
    const p = makeProtector({ currentStep: 'brief' });
    const result = p.check('Bash', { command: `cat > /tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, false);
  });

  it('allows Bash command that reads (not writes) brief.md', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: `cat /tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, false);
  });

  it('allows Bash command with no artifact references', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: 'echo hello > /tmp/output.txt' });
    assert.equal(result.blocked, false);
  });
});

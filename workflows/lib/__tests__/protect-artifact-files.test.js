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
      isRunningInAgent: (tp, agents) => {
        capturedPath = tp;
        capturedAgents = agents;
        return true;
      },
    });
    p.check(
      'Write',
      { file_path: `/tasks/${TICKET}/spec.md` },
      { transcript_path: '/tmp/transcript.json' }
    );
    assert.equal(capturedPath, '/tmp/transcript.json');
    assert.deepEqual(capturedAgents, ['spec-writer']);
  });

  it('passes full hookData as third arg to isRunningInAgent', () => {
    let capturedHookData = null;
    const p = makeProtector({
      currentStep: 'spec',
      isRunningInAgent: (tp, agents, hd) => {
        capturedHookData = hd;
        return true;
      },
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
    const result = p.check('Bash', {
      command: `cp /tmp/report.md /tasks/${TICKET}/tests.check.md`,
    });
    assert.equal(result.blocked, true);
  });

  it('blocks Bash sed -i on brief.md outside step', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', { command: `sed -i 's/old/new/' /tasks/${TICKET}/brief.md` });
    assert.equal(result.blocked, true);
  });

  it('blocks Bash node writeFileSync to brief.md outside step', () => {
    const p = makeProtector({ currentStep: 'implement' });
    const result = p.check('Bash', {
      command: `node -e "require('fs').writeFileSync('/tasks/${TICKET}/brief.md', 'hacked')"`,
    });
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

// ─── contentGuard ─────────────────────────────────────────────────────────────

describe('contentGuard', () => {
  const TICKET = 'TEST-123';

  function makeProtectorWithGuard(guardFn, overrides = {}) {
    return createArtifactProtector({
      artifacts: [
        {
          basename: 'brief.md',
          step: 'brief',
          agents: ['brief-writer'],
          contentGuard: guardFn,
        },
        { basename: 'spec.md', step: 'spec', agents: ['spec-writer'] },
      ],
      getStepInProgress: () => overrides.currentStep || 'brief',
      isRunningInAgent: () => true,
      getTicketId: () => TICKET,
      ...overrides,
    });
  }

  it('blocks when contentGuard returns blocked: true (Write)', () => {
    const guard = () => ({ blocked: true, message: 'Content not allowed' });
    const p = makeProtectorWithGuard(guard);
    const result = p.check('Write', {
      file_path: `/tasks/${TICKET}/brief.md`,
      content: 'some content',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'content');
    assert.equal(result.message, 'Content not allowed');
  });

  it('allows when contentGuard returns blocked: false (Write)', () => {
    const guard = () => ({ blocked: false });
    const p = makeProtectorWithGuard(guard);
    const result = p.check('Write', {
      file_path: `/tasks/${TICKET}/brief.md`,
      content: 'some content',
    });
    assert.equal(result.blocked, false);
  });

  it('blocks when contentGuard returns blocked: true (Edit)', () => {
    const guard = (content) => {
      if (content.includes('bad')) return { blocked: true, message: 'Bad content in edit' };
      return { blocked: false };
    };
    const p = makeProtectorWithGuard(guard);
    const result = p.check('Edit', {
      file_path: `/tasks/${TICKET}/brief.md`,
      new_string: 'this is bad content',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'content');
    assert.ok(result.message.includes('Bad content'));
  });

  it('blocks when contentGuard returns blocked: true (MultiEdit)', () => {
    const guard = () => ({ blocked: true, message: 'Blocked by guard' });
    const p = makeProtectorWithGuard(guard);
    const result = p.check('MultiEdit', {
      file_path: `/tasks/${TICKET}/brief.md`,
      new_string: 'multi edit content',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'content');
  });

  it('does NOT call contentGuard for Bash tool', () => {
    let called = false;
    const guard = () => {
      called = true;
      return { blocked: true, message: 'Should not reach here' };
    };
    const p = makeProtectorWithGuard(guard);
    // Bash that writes to brief.md — should be checked for step/agent but NOT contentGuard
    const result = p.check('Bash', { command: `cat > /tasks/${TICKET}/brief.md` });
    assert.equal(called, false);
    assert.equal(result.blocked, false);
  });

  it('does NOT call contentGuard when rule has no contentGuard defined', () => {
    // spec.md has no contentGuard in our setup
    const p = makeProtectorWithGuard(null, { currentStep: 'spec' });
    const result = p.check('Write', {
      file_path: `/tasks/${TICKET}/spec.md`,
      content: 'spec content',
    });
    assert.equal(result.blocked, false);
  });

  it('passes content and currentStep to contentGuard', () => {
    let capturedContent = null;
    let capturedStep = null;
    const guard = (content, step) => {
      capturedContent = content;
      capturedStep = step;
      return { blocked: false };
    };
    const p = makeProtectorWithGuard(guard, { currentStep: 'brief' });
    p.check('Write', {
      file_path: `/tasks/${TICKET}/brief.md`,
      content: 'hello world',
    });
    assert.equal(capturedContent, 'hello world');
    assert.equal(capturedStep, 'brief');
  });

  it('does not call contentGuard when content is empty', () => {
    let called = false;
    const guard = () => {
      called = true;
      return { blocked: true, message: 'Should not reach' };
    };
    const p = makeProtectorWithGuard(guard);
    const result = p.check('Write', {
      file_path: `/tasks/${TICKET}/brief.md`,
      content: '',
    });
    assert.equal(called, false);
    assert.equal(result.blocked, false);
  });
});

// ─── contentGuard Edit bypass fix (GH-219) ──────────────────────────────────

describe('contentGuard with Edit tool (file-read simulation)', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const TICKET = 'TEST-123';

  let tmpDir;

  function makeProtectorWithGuard(guardFn, overrides = {}) {
    return createArtifactProtector({
      artifacts: [
        {
          basename: 'brief.md',
          step: 'brief',
          agents: ['brief-writer'],
          contentGuard: guardFn,
        },
      ],
      getStepInProgress: () => overrides.currentStep || 'brief',
      isRunningInAgent: () => true,
      getTicketId: () => TICKET,
      ...overrides,
    });
  }

  it('contentGuard blocks Edit that resolves a blocking question', () => {
    // Create a temp file with unresolved question
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-test-'));
    const filePath = path.join(tmpDir, 'tasks', TICKET, 'brief.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fileContent = [
      '# Brief',
      '',
      '## Open Questions',
      '- question: What DB to use?',
      '  resolved: false',
      '  category: architectural',
    ].join('\n');
    fs.writeFileSync(filePath, fileContent);

    // Guard that blocks if all questions are resolved
    const guard = (content) => {
      if (content.includes('resolved: false')) return { blocked: false };
      return { blocked: true, message: 'Cannot resolve blocking questions via edit' };
    };

    const p = makeProtectorWithGuard(guard);
    // Edit changes resolved: false → resolved: true (the bypass vector)
    const result = p.check('Edit', {
      file_path: filePath,
      old_string: 'resolved: false',
      new_string: 'resolved: true',
    });

    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'content');
    assert.ok(result.message.includes('Cannot resolve'));

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('contentGuard allows Edit that does not resolve blocking questions', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-test-'));
    const filePath = path.join(tmpDir, 'tasks', TICKET, 'brief.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fileContent = [
      '# Brief',
      '',
      '## Open Questions',
      '- question: What DB to use?',
      '  resolved: false',
      '  category: architectural',
    ].join('\n');
    fs.writeFileSync(filePath, fileContent);

    // Guard that blocks if all questions are resolved
    const guard = (content) => {
      if (content.includes('resolved: false')) return { blocked: false };
      return { blocked: true, message: 'Cannot resolve blocking questions via edit' };
    };

    const p = makeProtectorWithGuard(guard);
    // Edit fixes a typo — does NOT resolve the question
    const result = p.check('Edit', {
      file_path: filePath,
      old_string: 'What DB to use?',
      new_string: 'Which database to use?',
    });

    assert.equal(result.blocked, false);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('contentGuard falls back to new_string when file does not exist', () => {
    // Guard that blocks content with "resolved: true"
    const guard = (content) => {
      if (content.includes('resolved: true'))
        return { blocked: true, message: 'Blocked resolved' };
      return { blocked: false };
    };

    const p = makeProtectorWithGuard(guard);
    // File doesn't exist — falls back to checking new_string only
    const result = p.check('Edit', {
      file_path: '/nonexistent/tasks/TEST-123/brief.md',
      old_string: 'resolved: false',
      new_string: 'resolved: true',
    });

    // Falls back to new_string which contains "resolved: true" → blocked
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'content');
  });

  it('contentGuard falls back to new_string when file does not exist (allowed case)', () => {
    // Guard that only blocks full resolved content
    const guard = (content) => {
      if (content.includes('resolved: false'))
        return { blocked: true, message: 'Unresolved' };
      return { blocked: false };
    };

    const p = makeProtectorWithGuard(guard);
    const result = p.check('Edit', {
      file_path: '/nonexistent/tasks/TEST-123/brief.md',
      old_string: 'old text',
      new_string: 'new text without trigger',
    });

    assert.equal(result.blocked, false);
  });

  it('Write tool contentGuard still works unchanged', () => {
    const guard = (content) => {
      if (content.includes('resolved: false'))
        return { blocked: true, message: 'Has unresolved' };
      return { blocked: false };
    };

    const p = makeProtectorWithGuard(guard);
    const result = p.check('Write', {
      file_path: `/tasks/${TICKET}/brief.md`,
      content: '# Brief\nresolved: false\n',
    });

    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'content');
  });
});

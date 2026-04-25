/**
 * Tests for lib/protect-artifact-files.js
 *
 * Run: node --test lib/__tests__/protect-artifact-files.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
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

  // ── allowedSteps gating ──

  it('allows artifact in primary step', () => {
    const p = createArtifactProtector({
      artifacts: [{ basename: 'tasks.md', step: 'tasks', allowedSteps: ['task_review'] }],
      getStepInProgress: () => 'tasks',
      getTicketId: () => TICKET,
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/tasks.md` });
    assert.equal(result.blocked, false);
  });

  it('allows artifact in allowedSteps (task_review)', () => {
    const p = createArtifactProtector({
      artifacts: [{ basename: 'tasks.md', step: 'tasks', allowedSteps: ['task_review'] }],
      getStepInProgress: () => 'task_review',
      getTicketId: () => TICKET,
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/tasks.md` });
    assert.equal(result.blocked, false);
  });

  it('blocks artifact when neither primary step nor allowedSteps is in_progress', () => {
    const p = createArtifactProtector({
      artifacts: [{ basename: 'tasks.md', step: 'tasks', allowedSteps: ['task_review'] }],
      getStepInProgress: () => 'implement',
      getTicketId: () => TICKET,
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/tasks.md` });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
  });

  it('block message references both primary step and allowedSteps', () => {
    const p = createArtifactProtector({
      artifacts: [{ basename: 'tasks.md', step: 'tasks', allowedSteps: ['task_review'] }],
      getStepInProgress: () => 'implement',
      getTicketId: () => TICKET,
    });
    const result = p.check('Write', { file_path: `/tasks/${TICKET}/tasks.md` });
    assert.equal(result.blocked, true);
    assert.ok(result.message.includes('tasks'), 'message should include primary step');
    assert.ok(result.message.includes('task_review'), 'message should include allowedSteps');
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
      if (content.includes('resolved: true')) return { blocked: true, message: 'Blocked resolved' };
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
      if (content.includes('resolved: false')) return { blocked: true, message: 'Unresolved' };
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
      if (content.includes('resolved: false')) return { blocked: true, message: 'Has unresolved' };
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

// ─── Per-task path enforcement (.check.md) ────────────────────────────────────

describe('per-task path enforcement for .check.md', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const TICKET = 'TEST-456';

  let tmpDir;
  let savedTasksBase;

  function makeProtector(overrides = {}) {
    return createArtifactProtector({
      artifacts: [
        {
          pattern: /\.check\.md$/,
          step: 'check',
          allowedSteps: ['task_review'],
          agents: ['code-checker'],
        },
      ],
      getStepInProgress: () => overrides.currentStep || 'task_review',
      isRunningInAgent: overrides.isRunningInAgent || (() => true),
      getTicketId: () => overrides.ticketId || TICKET,
      ...overrides,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-pertask-'));
    savedTasksBase = process.env.TASKS_BASE;
    process.env.TASKS_BASE = tmpDir;
  });

  afterEach(() => {
    if (savedTasksBase !== undefined) {
      process.env.TASKS_BASE = savedTasksBase;
    } else {
      delete process.env.TASKS_BASE;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks .check.md at ticket root when tasksMeta.totalTasks > 0', () => {
    // Create .work-state.json with per-task mode
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1 } })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('task2'));
    assert.ok(result.message.includes('Per-task mode'));
  });

  it('allows .check.md in task subfolder when per-task mode active', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task2'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1 } })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'task2', 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, false);
  });

  it('allows .check.md at ticket root when no tasksMeta', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ currentStep: 'check' })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, false);
  });

  it('fails open when .work-state.json is missing', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    // No .work-state.json created

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, false);
  });

  it('block message includes correct task number and suggested path', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 5, currentTaskIndex: 3 } })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'code.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.ok(result.message.includes('task4'));
    assert.ok(result.message.includes('code.check.md'));
  });

  it('blocks Bash write of .check.md at ticket root when per-task mode active', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    const result = p.check('Bash', {
      command: `cat > ${path.join(ticketDir, 'tests.check.md')}`,
    });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('task1'));
    assert.ok(result.message.includes('Per-task mode'));
  });

  it('allows Bash write of .check.md to correct task folder', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task2'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1 } })
    );

    const p = makeProtector();
    const result = p.check('Bash', {
      command: `cat > ${path.join(ticketDir, 'task2', 'tests.check.md')}`,
    });
    assert.equal(result.blocked, false);
  });

  it('fails open when Bash target path cannot be extracted', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    // Command mentions .check.md but no extractable path with /
    const result = p.check('Bash', {
      command: `echo tests.check.md | tee ${path.join(ticketDir, 'tests.check.md')}`,
    });
    // The tee path IS extractable, so this should still be blocked
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
  });

  it('Bash write with unextractable .check.md path fails open on per-task check', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    // Command where the basename appears but no token has both basename and /
    // The Bash vector still detects the artifact via pattern match on tokens,
    // and filePath is set to the full command. But extractBashTargetPath
    // can't find a clean path token — so per-task enforcement is skipped (fail-open).
    // We need a command that triggers write detection AND artifact pattern match
    // but where no single token has both the basename and a slash.
    const result = p.check('Bash', {
      command: `node -e "writeFileSync(p, d)" tests.check.md ${TICKET}`,
    });
    // Should not be blocked by per-task — fail-open
    // (step/agent checks pass because currentStep=check and isRunningInAgent=true)
    assert.equal(result.blocked, false);
  });

  it('blocks Bash write of .check.md to wrong task folder', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task3'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    // currentTaskIndex=0 → task1, but writing to task3/
    const result = p.check('Bash', {
      command: `cat > ${path.join(ticketDir, 'task3', 'tests.check.md')}`,
    });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('task 1'));
    assert.ok(result.message.includes('wrong task folder'));
  });

  it('blocks relative path input that resolves to ticket root', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1 } })
    );

    const p = makeProtector();
    // Use a relative path that resolves to the ticket root via ../
    const filePath = path.join(ticketDir, 'task2', '..', 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
  });

  it('path.resolve prevents bypass via ../ relative path traversal', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task2'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1 } })
    );

    const p = makeProtector();
    // Path with ../ that still lands in a task subfolder after resolution
    const filePath = path.join(ticketDir, 'task3', '..', 'task2', 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    // After path.resolve, this is ticketDir/task2/tests.check.md — allowed
    assert.equal(result.blocked, false);
  });

  it('defaults currentTaskIndex to 0 when NaN', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 'not-a-number' } })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    // NaN defaults to 0, so taskNum = 1
    assert.ok(result.message.includes('task1'));
  });

  it('defaults currentTaskIndex to 0 when undefined', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3 } })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('task1'));
  });

  it('clamps negative currentTaskIndex to 0', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: -5 } })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('task1'));
  });

  it('clamps currentTaskIndex exceeding totalTasks to last task', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 99 } })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    // Clamped to totalTasks-1=2, so taskNum=3
    assert.ok(result.message.includes('task3'));
  });

  it('blocks .check.md written to wrong task folder', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task3'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    // currentTaskIndex=0 → task1, but writing to task3/
    const filePath = path.join(ticketDir, 'task3', 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('task 1'));
    assert.ok(result.message.includes('wrong task folder'));
  });

  it('allows .check.md written to correct task folder', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task1'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    // currentTaskIndex=0 → task1, writing to task1/ — should be allowed
    const filePath = path.join(ticketDir, 'task1', 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, false);
  });

  it('blocks .check.md written to non-task subdirectory', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    // Writing to notes/ — not a valid task folder
    const filePath = path.join(ticketDir, 'notes', 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('wrong task folder'));
  });

  it('blocks .check.md nested inside a subdirectory of the correct task folder', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task2', 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1 } })
    );

    const p = makeProtector();
    // task2/notes/tests.check.md — nested inside task2, should be blocked
    const filePath = path.join(ticketDir, 'task2', 'notes', 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('wrong task folder'));
  });

  it('Bash cp extracts destination (last) path, not source', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    // cp source dest — destination is at ticket root, should be blocked
    const result = p.check('Bash', {
      command: `cp /tmp/tests.check.md ${path.join(ticketDir, 'tests.check.md')}`,
    });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('task1'));
  });

  it('does not treat ..foo.check.md as escaping the ticket dir', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1 } })
    );

    const p = makeProtector();
    // A file named ..foo.check.md at ticket root — should be treated as
    // within the ticket dir (isWithinTicketDir = true) and blocked at
    // ticket root level (per-task-path), NOT treated as directory escape.
    const filePath = path.join(ticketDir, '..foo.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    // Should suggest the correct task folder, not be treated as escaping
    assert.ok(result.message.includes('task2'));
    assert.ok(result.message.includes('Per-task mode'));
  });

  it('handles non-integer float currentTaskIndex by defaulting to 0', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1.7 } })
    );

    const p = makeProtector();
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    // 1.7 is not an integer, defaults to 0, taskNum=1
    assert.ok(result.message.includes('task1'));
  });

  it('blocks .check.md that escapes ticket directory via ../.. traversal', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task1'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector();
    // Construct path manually to preserve ../.. segments (path.join normalizes them away)
    const filePath = ticketDir + '/task1/../../other/tests.check.md';
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('outside ticket directory'));
  });

  it('allows .check.md at ticket root during check step (per-task routing skipped)', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 1 } })
    );

    const p = makeProtector({ currentStep: 'check' });
    const filePath = path.join(ticketDir, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, false);
  });

  it('blocks .check.md escaping ticket dir during check step (traversal guard still active)', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task1'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector({ currentStep: 'check' });
    const filePath = ticketDir + '/task1/../../other/tests.check.md';
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'per-task-path');
    assert.ok(result.message.includes('outside ticket directory'));
  });

  it('traversal block message suggests ticket root path during check step', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task1'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector({ currentStep: 'check' });
    const filePath = ticketDir + '/task1/../../other/tests.check.md';
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    // During check step, suggested path should be ticket root, not per-task
    assert.ok(result.message.includes(path.join(ticketDir, 'tests.check.md')));
    assert.ok(!result.message.includes('task1'));
  });

  it('traversal block message suggests per-task path during non-check step', () => {
    const ticketDir = path.join(tmpDir, TICKET);
    fs.mkdirSync(path.join(ticketDir, 'task1'), { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    const p = makeProtector({ currentStep: 'task_review' });
    const filePath = ticketDir + '/task1/../../other/tests.check.md';
    const result = p.check('Write', { file_path: filePath });
    assert.equal(result.blocked, true);
    // During non-check step, suggested path should be per-task
    assert.ok(result.message.includes(path.join(ticketDir, 'task1', 'tests.check.md')));
  });

  it('fails open when ticketId contains ../ (path traversal)', () => {
    // Create a state file at the traversal target to prove it is NOT read
    const outsideDir = path.join(tmpDir, 'secret');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, '.work-state.json'),
      JSON.stringify({ tasksMeta: { totalTasks: 3, currentTaskIndex: 0 } })
    );

    // ticketId with ../ that would escape TASKS_BASE
    const maliciousId = '../secret';
    const p = makeProtector({ ticketId: maliciousId });
    // The file path includes the malicious ticketId so the ticket-folder check passes
    const filePath = path.join(tmpDir, maliciousId, 'tests.check.md');
    const result = p.check('Write', { file_path: filePath });
    // Should NOT block — per-task enforcement is skipped (fail-open)
    // because statePath escapes TASKS_BASE
    assert.equal(result.blocked, false);
  });
});

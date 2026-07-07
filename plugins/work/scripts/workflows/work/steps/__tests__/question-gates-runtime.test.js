/**
 * Dual-runtime tests for the /work question-gate emission sites (WP-08, C3):
 * brief-gate, task-review, and the implement-gate planner hold.
 *
 * Claude characterization: command labels and prompts are byte-identical to
 * the pre-vocabulary HEAD literals. Codex: the command label renders
 * `request_user_input`, prompts swap the question vocabulary, and non-
 * interactive modes append the parked-gate notice ([work:codex-degraded]).
 *
 * Run: node --test scripts/workflows/work/steps/__tests__/question-gates-runtime.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { STEPS } = require('../../step-registry');
const { resetRuntimeCache } = require('../../../lib/runtime');
const { PARKED_NOTICE } = require('../../../lib/instruction-vocab');
const briefGateStep = require('../brief-gate.js');
const taskReviewStep = require('../task-review.js');
const {
  buildPlannerHoldInstruction,
} = require('../../lib/step-enrichments/implement-gate/planner-hold');

const ENV_KEYS = [
  'AGENT_RUNTIME',
  'AGENT_RUNTIME_MODE',
  'TASK_REVIEW_ENABLED',
  'TASK_REVIEW_MAX_FIXES',
];
const saved = {};
const createdDirs = [];

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
  while (createdDirs.length) {
    fs.rmSync(createdDirs.pop(), { recursive: true, force: true });
  }
});

function pin(runtime, mode) {
  process.env.AGENT_RUNTIME = runtime;
  if (mode) process.env.AGENT_RUNTIME_MODE = mode;
  resetRuntimeCache();
}

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

// ─── brief-gate ─────────────────────────────────────────────────────────────

const BRIEF_BLOCKING = [
  '# Brief',
  '',
  '## Open Questions',
  '',
  '- **Question:** Which queue backend should we adopt?',
  '  - `scope: architectural`',
  '  - `rationale: affects all downstream services`',
  '  - `resolved: false`',
  '',
].join('\n');

function runBriefGate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qgate-rt-'));
  createdDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'brief.md'), BRIEF_BLOCKING, 'utf8');
  const { add, entries } = makeAdd();
  briefGateStep(add, { hasBrief: true }, { STEPS, ticket: 'TEST-1', tasksDir: dir, path });
  return entries[0];
}

describe('brief-gate question site', () => {
  it('claude: command + prompt byte-identical to HEAD', () => {
    pin('claude');
    const entry = runBriefGate();
    assert.equal(entry.command, 'AskUserQuestion');
    assert.equal(
      entry.agentPrompt,
      'Use AskUserQuestion to resolve 1 unresolved open question(s) in brief.md, then call applyBriefResolutions() to persist the answers.'
    );
  });

  it('codex interactive: request_user_input prose, no parked notice', () => {
    pin('codex', 'interactive');
    const entry = runBriefGate();
    assert.equal(entry.command, 'request_user_input');
    assert.match(entry.agentPrompt, /Use request_user_input to resolve 1 unresolved/);
    assert.ok(!entry.agentPrompt.includes(PARKED_NOTICE));
  });

  it('codex exec: parked-gate notice appended', () => {
    pin('codex', 'exec');
    const entry = runBriefGate();
    assert.ok(entry.agentPrompt.endsWith(PARKED_NOTICE));
    // The canonical payload stays untouched (askUserQuestionPayload contract).
    assert.ok(Array.isArray(entry.askUserQuestionPayload.questions));
  });
});

// ─── task-review ────────────────────────────────────────────────────────────

function runTaskReview() {
  const { add, entries } = makeAdd();
  const taskData = [
    { num: 1, title: 'Task A', isCheckpoint: false },
    { num: 2, title: 'Task B', isCheckpoint: false },
  ];
  const s = {
    hasTasks: true,
    workState: {
      tasksMeta: {
        currentTaskIndex: 0,
        tasks: [{ id: 'task-1', taskReviewFixRounds: 2 }, { id: 'task-2' }],
      },
    },
  };
  taskReviewStep(add, s, {
    STEPS,
    ticket: 'TEST-1',
    tasksDir: path.join(os.tmpdir(), 'qgate-rt-tasks'),
    path,
    _taskData: taskData,
    _currentTaskIdx: 0,
  });
  return entries[0];
}

describe('task-review escalation site', () => {
  it('claude: command + prompt byte-identical to HEAD', () => {
    pin('claude');
    const entry = runTaskReview();
    assert.equal(entry.command, 'AskUserQuestion');
    assert.equal(
      entry.agentPrompt,
      'Task 1 has exhausted 2/2 fix rounds. Use AskUserQuestion to ask the user whether to continue fixing, skip the review, or abort.'
    );
  });

  it('codex: request_user_input command + parked notice in unknown mode', () => {
    pin('codex');
    const entry = runTaskReview();
    assert.equal(entry.command, 'request_user_input');
    assert.match(entry.agentPrompt, /Use request_user_input to ask the user/);
    assert.ok(entry.agentPrompt.endsWith(PARKED_NOTICE));
  });
});

// ─── planner hold ───────────────────────────────────────────────────────────

const HOLD_WS = {
  _tddRetryTask: 3,
  _tddRetryReason: 'malformed Test Strategy',
  _tddRetryCommand: 'pnpm test',
  _tddRetryExitCode: 1,
  _tddRetryOutputTail: 'boom',
};

describe('planner-hold operator suggestion', () => {
  it('claude: suggestion byte-identical to HEAD', () => {
    pin('claude');
    const instr = buildPlannerHoldInstruction(HOLD_WS, 'TEST-1');
    assert.equal(
      instr.suggestion,
      [
        'OPERATOR HOLD — do NOT re-dispatch a developer agent: the defect is in',
        'tasks.md, which is planner-owned and LOCKED during implement, so no',
        'implementing agent may correct it. Surface the defect above to the',
        'operator with AskUserQuestion, offering:',
        '  1. Operator corrects the "## Task 3" section of tasks.md outside',
        '     the session — the gate hashes that section and resumes the normal',
        '     flow automatically once its content changes (tasksMeta is re-synced',
        '     by the gate reconciler on the same pass).',
        '  2. Re-run the tasks phase to regenerate tasks.md.',
      ].join('\n')
    );
  });

  it('codex: question vocabulary swapped + parked notice, action stays blocked', () => {
    pin('codex');
    const instr = buildPlannerHoldInstruction(HOLD_WS, 'TEST-1');
    assert.equal(instr.action, 'blocked');
    assert.match(instr.suggestion, /operator with request_user_input, offering:/);
    assert.ok(instr.suggestion.endsWith(PARKED_NOTICE));
  });
});

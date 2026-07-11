/**
 * Unit tests for the brief-gate step module (GH-215, Task 4).
 *
 * Covers the four DEFER/RUN decision paths plus the post-resolve handler
 * behavior (rewrite-on-answer, no-op-on-cancel).
 *
 * Run: node --test workflows/work/steps/__tests__/brief-gate.test.js
 */

'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { STEPS } = require('../../step-registry');

// ─── Test doubles matching bootstrap.test.js ────────────────────────────────

// Placeholder path roots used for tests that never actually touch the disk.
// Built from os.tmpdir() instead of a hard-coded "/tmp/..." so CodeQL's
// js/file-system-race rule doesn't flag the strings as insecure tmp file
// creation. Tests that DO write real files derive their own dir from
// fs.mkdtempSync (see `dir` callers below) and pass it via the `tasksDir`
// override.
const FAKE_TMP_ROOT = path.join(os.tmpdir(), 'brief-gate-fake-roots');

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    description: null,
    rework: false,
    safeName: 'TEST-100',
    worktreeDir: path.join(FAKE_TMP_ROOT, 'worktrees', 'my-project-TEST-100'),
    tasksDir: path.join(FAKE_TMP_ROOT, 'tasks', 'TEST-100'),
    t: 'TEST-100',
    path,
    fileExists: (p) => fs.existsSync(p),
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    worktreeExists: true,
    hasBrief: true,
    pr: null,
    ...overrides,
  };
}

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

// ─── Fixture helpers ────────────────────────────────────────────────────────

const BRIEF_ALL_LOCAL = [
  '# Brief',
  '',
  '## Open Questions',
  '',
  '- **Question:** How should we name the local helper?',
  '  - `scope: local`',
  '  - `rationale: scoped to this ticket only`',
  '  - `resolved: false`',
  '',
].join('\n');

const BRIEF_ONE_BLOCKING_ARCH = [
  '# Brief',
  '',
  '## Open Questions',
  '',
  '- **Question:** Which queue backend should we adopt for cross-service jobs?',
  '  - `scope: architectural`',
  '  - `rationale: affects all downstream services`',
  '  - `resolved: false`',
  '',
].join('\n');

// GH-543: five blocking questions — one over the AskUserQuestion 4-cap.
const BRIEF_FIVE_BLOCKING = [
  '# Brief',
  '',
  '## Open Questions',
  '',
  ...[1, 2, 3, 4, 5].flatMap((i) => [
    `- **Question:** Cross-ticket question ${i}?`,
    '  - `scope: cross-ticket`',
    `  - \`rationale: affects sibling ${i}\``,
    '  - `resolved: false`',
    '',
  ]),
].join('\n');

// GH-543: no open questions, one undecided sibling-gap entry.
const BRIEF_ONE_SIBLING_GAP = [
  '# Brief',
  '',
  '## Out of scope (sibling-owned)',
  '- `lib/x.ts` — owned by GH-100 (status: Open, PR: none). Reason: shared surface.',
  '',
].join('\n');

const BRIEF_SIBLING_GAP_DECIDED = [
  BRIEF_ONE_SIBLING_GAP,
  '## Sibling-gap decisions',
  '- `lib/x.ts` — decision: wait-for-sibling; timestamp: 2026-07-11T00:00:00Z',
  '',
].join('\n');

function makeTmpTasksDir(briefContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-gate-test-'));
  if (briefContent !== null) {
    fs.writeFileSync(path.join(dir, 'brief.md'), briefContent, 'utf8');
  }
  return dir;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('brief-gate step', () => {
  let briefGateStep;
  let applyBriefResolutions;
  const createdDirs = [];
  before(() => {
    const mod = require(path.join(__dirname, '..', 'brief-gate.js'));
    briefGateStep = typeof mod === 'function' ? mod : mod.briefGateStep;
    applyBriefResolutions = mod.applyBriefResolutions;
  });

  afterEach(() => {
    while (createdDirs.length) rmrf(createdDirs.pop());
  });

  it('exports a function', () => {
    assert.equal(typeof briefGateStep, 'function');
  });

  // GH-253 Task 4: WORK_BRIEF_ENABLED toggle removed — brief-gate no longer
  // checks process.env.WORK_BRIEF_ENABLED.
  it('does not reference WORK_BRIEF_ENABLED in source code', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'brief-gate.js'), 'utf8');
    assert.ok(
      !src.includes('WORK_BRIEF_ENABLED'),
      'brief-gate.js must not contain WORK_BRIEF_ENABLED'
    );
  });

  it('ignores WORK_BRIEF_ENABLED=0 and still evaluates brief.md normally', () => {
    const prev = process.env.WORK_BRIEF_ENABLED;
    process.env.WORK_BRIEF_ENABLED = '0';
    try {
      const { add, entries } = makeAdd();
      // hasBrief=false should DEFER with "No brief.md present", NOT "disabled"
      briefGateStep(add, makeState({ hasBrief: false }), makeCtx());
      assert.equal(entries.length, 1);
      assert.equal(entries[0].step, STEPS.brief_gate);
      assert.equal(entries[0].action, 'DEFER');
      assert.match(entries[0].reason, /no brief/i);
    } finally {
      if (prev === undefined) delete process.env.WORK_BRIEF_ENABLED;
      else process.env.WORK_BRIEF_ENABLED = prev;
    }
  });

  it('DEFERs when no brief.md is present', () => {
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState({ hasBrief: false }), makeCtx());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.brief_gate);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /no brief/i);
  });

  it('DEFERs when all questions are resolved (only-local brief)', () => {
    const dir = makeTmpTasksDir(BRIEF_ALL_LOCAL);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].step, STEPS.brief_gate);
    assert.equal(entries[0].action, 'DEFER');
    assert.match(entries[0].reason, /resolved|no open/i);
  });

  it('RUNs with AskUserQuestion payload when a blocking architectural question exists', () => {
    const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.step, STEPS.brief_gate);
    assert.equal(entry.action, 'RUN');
    assert.equal(entry.command, 'AskUserQuestion');
    assert.match(entry.reason, /1 .*unresolved/i);
    assert.ok(entry.askUserQuestionPayload, 'RUN entry must carry askUserQuestionPayload');
    assert.ok(
      Array.isArray(entry.askUserQuestionPayload.questions) ||
        entry.askUserQuestionPayload.question,
      'payload must carry questions[] or a question field'
    );
    assert.equal(entry.onResolve, 'rewrite brief.md');
    assert.equal(entry.agentType, 'general-purpose', 'AskUserQuestion RUN must specify agentType');
    assert.equal(
      typeof entry.agentPrompt,
      'string',
      'AskUserQuestion RUN must carry agentPrompt string'
    );
    assert.match(entry.agentPrompt, /AskUserQuestion/, 'agentPrompt must mention AskUserQuestion');
    assert.match(
      entry.agentPrompt,
      /applyBriefResolutions/,
      'agentPrompt must mention applyBriefResolutions'
    );
  });

  it('RUN entry postResolveCommand uses the file transport (GH-543: no argv-JSON)', () => {
    const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.action, 'RUN');
    assert.equal(
      typeof entry.postResolveCommand,
      'string',
      'RUN entry must carry postResolveCommand string'
    );
    assert.match(
      entry.postResolveCommand,
      /apply-brief-gate-answers\.js/,
      'postResolveCommand must invoke the answers-file CLI'
    );
    assert.ok(
      !entry.postResolveCommand.includes('$RESOLUTIONS_JSON'),
      'postResolveCommand must not interpolate answer JSON on the command line'
    );
    assert.ok(
      !entry.postResolveCommand.includes('node -e'),
      'postResolveCommand must not be a node -e one-liner'
    );
    // Verify the path includes the actual briefPath (tasks dir + brief.md)
    const expectedBriefPath = path.join(dir, 'brief.md');
    assert.ok(
      entry.postResolveCommand.includes(expectedBriefPath),
      `postResolveCommand must include briefPath: ${expectedBriefPath}`
    );
  });

  it('tags every payload question with kind and applyKey (GH-543 envelope routing)', () => {
    const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    const questions = entries[0].askUserQuestionPayload.questions;
    assert.equal(questions.length, 1);
    assert.equal(questions[0].kind, 'open-question');
    assert.equal(
      questions[0].applyKey,
      'Which queue backend should we adopt for cross-service jobs?'
    );
  });

  it('appends the batching suffix to the prompt when more than 4 questions block (GH-543)', () => {
    const dir = makeTmpTasksDir(BRIEF_FIVE_BLOCKING);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'RUN');
    assert.match(entries[0].agentPrompt, /\(in batches of at most 4\)/);
  });

  it('does NOT append the batching suffix for 4 or fewer blocking questions (pin: byte-identical prompt)', () => {
    const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
    createdDirs.push(dir);
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
    assert.ok(!entries[0].agentPrompt.includes('(in batches of at most 4)'));
  });

  describe('sibling-gap RUN extension (GH-543 trailing-batch delivery)', () => {
    it('stays RUN when open questions are resolved but sibling gaps remain undecided', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_SIBLING_GAP);
      createdDirs.push(dir);
      const { add, entries } = makeAdd();
      briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
      assert.equal(entries.length, 1);
      const entry = entries[0];
      assert.equal(entry.action, 'RUN', 'undecided sibling gaps must keep the gate RUN');
      assert.match(entry.reason, /1 .*sibling-gap/i);
      // Same delegate shape as the open-question branch so enrichAndReturn
      // executes the enrichment chain (injector → question-router).
      assert.equal(entry.agentType, 'general-purpose');
      assert.equal(typeof entry.agentPrompt, 'string');
      assert.ok(entry.askUserQuestionPayload, 'RUN entry must carry askUserQuestionPayload');
      assert.equal(entry.onResolve, 'rewrite brief.md');
      assert.match(entry.postResolveCommand, /apply-brief-gate-answers\.js/);
    });

    it('DEFERs when every sibling gap has a recorded decision', () => {
      const dir = makeTmpTasksDir(BRIEF_SIBLING_GAP_DECIDED);
      createdDirs.push(dir);
      const { add, entries } = makeAdd();
      briefGateStep(add, makeState(), makeCtx({ tasksDir: dir }));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, 'DEFER');
      assert.match(entries[0].reason, /resolved/i);
    });
  });

  it('emits RUN (not SKIP) when brief.md is unreadable so planner shows gate needs attention', () => {
    const dir = makeTmpTasksDir(null); // no brief.md file
    createdDirs.push(dir);
    // But s.hasBrief is true — simulates stale state where brief vanished.
    const { add, entries } = makeAdd();
    briefGateStep(add, makeState({ hasBrief: true }), makeCtx({ tasksDir: dir }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'RUN', 'unreadable brief must emit RUN, not SKIP');
    assert.match(entries[0].reason, /unreadable|regenerate/i);
    assert.equal(entries[0].command, '/brief', 'unreadable RUN must carry /brief command');
    assert.equal(entries[0].agentType, 'skill', 'unreadable RUN must specify agentType: skill');
    assert.equal(
      entries[0].agentPrompt,
      '/brief',
      'unreadable RUN must specify agentPrompt: /brief'
    );
  });

  describe('applyBriefResolutions (post-resolve handler)', () => {
    it('rewrites brief.md when resolutions are provided', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');

      const resolutions = new Map([
        [
          'Which queue backend should we adopt for cross-service jobs?',
          'Use SQS for all cross-service jobs.',
        ],
      ]);

      applyBriefResolutions(briefPath, resolutions);

      const updated = fs.readFileSync(briefPath, 'utf8');
      assert.match(updated, /resolved:\s*true/);
      assert.match(updated, /\*\*Resolution:\*\*\s*Use SQS/);
    });

    it('is a no-op when resolutions are undefined (user cancellation)', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');
      const before = fs.readFileSync(briefPath, 'utf8');

      applyBriefResolutions(briefPath, undefined);

      const after = fs.readFileSync(briefPath, 'utf8');
      assert.equal(after, before, 'brief.md must be byte-identical on cancel');
    });

    it('is a no-op when resolutions map is empty', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');
      const before = fs.readFileSync(briefPath, 'utf8');

      applyBriefResolutions(briefPath, new Map());

      const after = fs.readFileSync(briefPath, 'utf8');
      assert.equal(after, before, 'brief.md must be byte-identical on empty map');
    });

    it('returns false when fs.writeFileSync throws (EACCES/ENOSPC/etc)', () => {
      // The read path already returns false on failure (fail-closed). The
      // write path must mirror that no-throw contract: an EACCES/ENOSPC
      // during writeFileSync must not propagate as an uncaught exception to
      // the orchestrator — applyBriefResolutions must simply return false.
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');
      const before = fs.readFileSync(briefPath, 'utf8');

      const originalWriteFileSync = fs.writeFileSync;
      fs.writeFileSync = function patchedWriteFileSync(p, ...rest) {
        if (typeof p === 'string' && p === briefPath) {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return originalWriteFileSync.call(fs, p, ...rest);
      };

      try {
        const resolutions = new Map([
          [
            'Which queue backend should we adopt for cross-service jobs?',
            'Use SQS for all cross-service jobs.',
          ],
        ]);
        const result = applyBriefResolutions(briefPath, resolutions);
        assert.equal(result, false, 'applyBriefResolutions must return false on write failure');
      } finally {
        fs.writeFileSync = originalWriteFileSync;
      }

      // brief.md must be byte-equal — no partial write, no crash.
      const after = fs.readFileSync(briefPath, 'utf8');
      assert.equal(after, before, 'brief.md must remain byte-identical after write failure');
    });

    it('refuses outside brief_gate when .work-state.json exists (GH-543 step guard)', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');
      fs.writeFileSync(
        path.join(dir, '.work-state.json'),
        JSON.stringify({ stepStatus: { brief_gate: 'completed', spec: 'in_progress' } }),
        'utf8'
      );
      const before = fs.readFileSync(briefPath, 'utf8');

      const result = applyBriefResolutions(
        briefPath,
        new Map([
          [
            'Which queue backend should we adopt for cross-service jobs?',
            'Use SQS for all cross-service jobs.',
          ],
        ])
      );

      assert.equal(result, false, 'wrapper must refuse when another step is in_progress');
      const after = fs.readFileSync(briefPath, 'utf8');
      assert.equal(after, before, 'brief.md must be untouched on refusal');
    });

    it('still applies when .work-state.json shows brief_gate in_progress', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');
      fs.writeFileSync(
        path.join(dir, '.work-state.json'),
        JSON.stringify({ stepStatus: { brief: 'completed', brief_gate: 'in_progress' } }),
        'utf8'
      );

      const result = applyBriefResolutions(
        briefPath,
        new Map([
          [
            'Which queue backend should we adopt for cross-service jobs?',
            'Use SQS for all cross-service jobs.',
          ],
        ])
      );

      assert.equal(result, true);
      assert.match(fs.readFileSync(briefPath, 'utf8'), /\*\*Resolution:\*\*\s*Use SQS/);
    });

    it('returns false without touching brief.md for non-object resolutions (number/string/boolean)', () => {
      const dir = makeTmpTasksDir(BRIEF_ONE_BLOCKING_ARCH);
      createdDirs.push(dir);
      const briefPath = path.join(dir, 'brief.md');
      const before = fs.readFileSync(briefPath, 'utf8');

      // Monkey-patch fs.readFileSync to detect if brief-gate reads the file
      // while handling a stray non-object. A type guard at the top of
      // applyBriefResolutions must bail out BEFORE any I/O.
      const originalReadFileSync = fs.readFileSync;
      let readCallsForBrief = 0;
      fs.readFileSync = function patchedReadFileSync(p, ...rest) {
        if (typeof p === 'string' && p === briefPath) {
          readCallsForBrief += 1;
        }
        return originalReadFileSync.call(fs, p, ...rest);
      };

      try {
        // number
        assert.equal(
          applyBriefResolutions(briefPath, 42),
          false,
          'number resolutions must return false'
        );
        // string
        assert.equal(
          applyBriefResolutions(briefPath, 'not a map'),
          false,
          'string resolutions must return false'
        );
        // boolean
        assert.equal(
          applyBriefResolutions(briefPath, true),
          false,
          'boolean resolutions must return false'
        );
        // symbol (another non-object primitive)
        assert.equal(
          applyBriefResolutions(briefPath, Symbol('x')),
          false,
          'symbol resolutions must return false'
        );

        assert.equal(
          readCallsForBrief,
          0,
          'brief.md must not be read when resolutions is a non-object primitive'
        );
      } finally {
        fs.readFileSync = originalReadFileSync;
      }

      const after = originalReadFileSync.call(fs, briefPath, 'utf8');
      assert.equal(after, before, 'brief.md must be byte-identical after non-object inputs');
    });
  });
});

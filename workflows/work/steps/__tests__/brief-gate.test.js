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

function makeCtx(overrides = {}) {
  return {
    STEPS,
    ticket: 'TEST-100',
    description: null,
    rework: false,
    safeName: 'TEST-100',
    worktreeDir: '/tmp/worktrees/my-project-TEST-100',
    tasksDir: '/tmp/tasks/TEST-100',
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

  it('RUN entry includes postResolveCommand referencing applyBriefResolutions', () => {
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
      /applyBriefResolutions/,
      'postResolveCommand must reference applyBriefResolutions'
    );
    assert.match(
      entry.postResolveCommand,
      /brief-gate\.js/,
      'postResolveCommand must require brief-gate.js'
    );
    assert.match(
      entry.postResolveCommand,
      /\$RESOLUTIONS_JSON/,
      'postResolveCommand must reference $RESOLUTIONS_JSON placeholder'
    );
    assert.match(
      entry.postResolveCommand,
      /node -e/,
      'postResolveCommand must be a node -e one-liner'
    );
    // Verify the path includes the actual briefPath (tasks dir + brief.md)
    const expectedBriefPath = path.join(dir, 'brief.md');
    assert.ok(
      entry.postResolveCommand.includes(expectedBriefPath),
      `postResolveCommand must include briefPath: ${expectedBriefPath}`
    );
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

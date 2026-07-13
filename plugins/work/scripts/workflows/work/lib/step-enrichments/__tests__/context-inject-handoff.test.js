/**
 * Tests for step-enrichments/context-inject.js — resume handoff read-path (GH-315, Task 4).
 *
 * Covers R4 (resume injects the `.continue-here.md` handoff AHEAD of the
 * existing "Required Reading" block) and R5 (clear-after-advance: inject sets
 * the transient `resumeHandoffPending` marker and the handoff is deleted after
 * the first successful post-resume step advance so stale narrative is never
 * re-injected into a later step).
 *
 * Run: node --test scripts/workflows/work/lib/step-enrichments/__tests__/context-inject-handoff.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const contextInject = require('../context-inject');
const handoff = require('../../../../lib/handoff');

// Minimal registry mirroring the real enrichment registry: capture the fns
// registered per step and run them in registration order.
function makeRegistry() {
  const byStep = {};
  const register = (step, fn) => {
    if (!byStep[step]) byStep[step] = [];
    byStep[step].push(fn);
  };
  const run = (step, entry, ctx) => {
    for (const fn of byStep[step] || []) fn(entry, ctx);
  };
  return { register, run, byStep };
}

const VALID_HANDOFF = [
  '## Decisions made (and why)',
  '- Chose approach X because Y.',
  '',
  '## Blockers / warnings',
  '- Watch out for the flaky Z test.',
  '',
  '## What was in flight',
  '- Half-done: wiring the enricher.',
  '',
].join('\n');

let tmp;
let ticket;
let tasksDir;
let savedTasksBase;
let savedWorktreesBase;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cih-'));
  ticket = 'GH-315';
  tasksDir = path.join(tmp, ticket);
  fs.mkdirSync(tasksDir, { recursive: true });
  // The handoff.js helpers resolve their base from TASKS_BASE (or
  // WORKTREES_BASE/tasks). Point both at the temp base so readHandoff/
  // deleteHandoff and the enricher's tasksDir existence check agree.
  savedTasksBase = process.env.TASKS_BASE;
  savedWorktreesBase = process.env.WORKTREES_BASE;
  process.env.TASKS_BASE = tmp;
  delete process.env.WORKTREES_BASE;
});

afterEach(() => {
  if (savedTasksBase === undefined) delete process.env.TASKS_BASE;
  else process.env.TASKS_BASE = savedTasksBase;
  if (savedWorktreesBase === undefined) delete process.env.WORKTREES_BASE;
  else process.env.WORKTREES_BASE = savedWorktreesBase;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeArtifacts() {
  // The Required Reading block only appears when at least one artifact exists.
  fs.writeFileSync(path.join(tasksDir, 'brief.md'), '# Brief');
  fs.writeFileSync(path.join(tasksDir, 'spec.md'), '# Spec');
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), '# Tasks');
}

function writeHandoffFile(content = VALID_HANDOFF) {
  fs.writeFileSync(path.join(tasksDir, '.continue-here.md'), content);
}

function writeWorkState(extra = {}) {
  fs.writeFileSync(
    path.join(tasksDir, '.work-state.json'),
    JSON.stringify({ ticket, currentStep: 8, stepStatus: {}, ...extra }, null, 2)
  );
}

function readMarker() {
  const p = path.join(tasksDir, '.work-state.json');
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf8')).resumeHandoffPending;
}

const baseCtx = (overrides = {}) => ({
  tasksDir,
  ticket,
  TASKS_BASE: tmp,
  path,
  fs,
  ...overrides,
});

// --- 4.1: prepend the Continue-Here block ahead of Required Reading ---

describe('context-inject handoff — resume injects the handoff ahead of brief/spec/tasks required reading', () => {
  it('prepends a Continue Here block positioned before the Required Reading block', () => {
    writeArtifacts();
    writeHandoffFile();
    writeWorkState();

    const reg = makeRegistry();
    contextInject(reg.register);

    const entry = { step: 'implement', agentPrompt: 'BASE' };
    reg.run('implement', entry, baseCtx());

    const prompt = entry.agentPrompt;
    assert.match(prompt, /Continue Here/, 'Continue Here block must be present');
    assert.match(prompt, /Required Reading/, 'Required Reading block must still be present');

    const continueIdx = prompt.indexOf('Continue Here');
    const requiredIdx = prompt.indexOf('Required Reading');
    assert.ok(
      continueIdx >= 0 && requiredIdx >= 0 && continueIdx < requiredIdx,
      `Continue Here (@${continueIdx}) must precede Required Reading (@${requiredIdx})`
    );
  });

  it('surfaces the prior decisions/blockers narrative from .continue-here.md', () => {
    writeArtifacts();
    writeHandoffFile();
    writeWorkState();

    const reg = makeRegistry();
    contextInject(reg.register);

    const entry = { step: 'implement', agentPrompt: '' };
    reg.run('implement', entry, baseCtx());

    // The injected block references the handoff artifact so the agent reads it.
    assert.match(entry.agentPrompt, /\.continue-here\.md/);
  });
});

describe('context-inject handoff — no handoff injected when .continue-here.md is absent', () => {
  it('emits no Continue Here block and leaves Required Reading unchanged', () => {
    writeArtifacts();
    writeWorkState();
    // No .continue-here.md written.

    // Baseline: run the enricher with no handoff to capture the Required
    // Reading output byte-for-byte.
    const reg = makeRegistry();
    contextInject(reg.register);
    const entry = { step: 'implement', agentPrompt: 'BASE' };
    reg.run('implement', entry, baseCtx());

    assert.doesNotMatch(
      entry.agentPrompt,
      /Continue Here/,
      'no Continue Here block when file absent'
    );
    assert.match(entry.agentPrompt, /Required Reading/, 'Required Reading still present');

    // The marker must NOT be set when there is no handoff to resume from.
    assert.notEqual(readMarker(), true, 'resumeHandoffPending must not be set without a handoff');
  });

  it('does not weaken the pre-change Required Reading output', () => {
    writeArtifacts();
    writeWorkState();

    const reg = makeRegistry();
    contextInject(reg.register);
    const entry = { step: 'implement', agentPrompt: '' };
    reg.run('implement', entry, baseCtx());

    // Existing Required Reading contract from context-inject.js.
    assert.match(entry.agentPrompt, /Required Reading \(MUST read before starting\)/);
    assert.match(entry.agentPrompt, /Read these files IN FULL before implementing/);
  });
});

// --- 4.2: set resumeHandoffPending on inject, delete after first advance ---

describe('context-inject handoff — handoff is deleted after the first successful post-resume step advance', () => {
  it('sets resumeHandoffPending on inject', () => {
    writeArtifacts();
    writeHandoffFile();
    writeWorkState();

    const reg = makeRegistry();
    contextInject(reg.register);
    const entry = { step: 'implement', agentPrompt: '' };
    reg.run('implement', entry, baseCtx());

    assert.equal(readMarker(), true, 'inject must set resumeHandoffPending on .work-state.json');
    // The handoff file is NOT deleted at inject time — only after the advance.
    assert.ok(
      handoff.readHandoff(ticket) !== null,
      'handoff still present immediately after inject'
    );
  });

  it('deletes .continue-here.md and clears the marker on the first advance', () => {
    writeArtifacts();
    writeHandoffFile();
    writeWorkState();

    const reg = makeRegistry();
    contextInject(reg.register);
    const entry = { step: 'implement', agentPrompt: '' };
    reg.run('implement', entry, baseCtx());
    assert.equal(readMarker(), true);

    // Simulate one successful post-resume step advance.
    assert.equal(
      typeof contextInject.clearResumeHandoff,
      'function',
      'clearResumeHandoff must be exported'
    );
    contextInject.clearResumeHandoff(baseCtx());

    assert.equal(
      handoff.readHandoff(ticket),
      null,
      '.continue-here.md must be deleted after advance'
    );
    assert.notEqual(readMarker(), true, 'resumeHandoffPending must be cleared after advance');
  });

  it('produces no Continue Here block on the next enrichment after deletion', () => {
    writeArtifacts();
    writeHandoffFile();
    writeWorkState();

    const reg = makeRegistry();
    contextInject(reg.register);

    // First step: inject sets the marker.
    const first = { step: 'implement', agentPrompt: '' };
    reg.run('implement', first, baseCtx());
    assert.match(first.agentPrompt, /Continue Here/);

    // Advance clears + deletes.
    contextInject.clearResumeHandoff(baseCtx());

    // Next step: no handoff to inject.
    const second = { step: 'implement', agentPrompt: '' };
    reg.run('implement', second, baseCtx());
    assert.doesNotMatch(
      second.agentPrompt,
      /Continue Here/,
      'stale narrative must not be re-injected'
    );
  });
});

describe('context-inject handoff — full pause-then-resume narrative handoff cycle', () => {
  it('injects first, marks pending, deletes after one advance, and stays clear thereafter', () => {
    // Pause: a valid handoff is authored (as /pause-work would).
    writeArtifacts();
    writeHandoffFile();
    writeWorkState();
    assert.deepEqual(handoff.validateHandoffSections(VALID_HANDOFF).missing, []);

    const reg = makeRegistry();
    contextInject(reg.register);

    // Resume step 1: Continue Here injected ahead of Required Reading + marker set.
    const resume = { step: 'implement', agentPrompt: 'BASE' };
    reg.run('implement', resume, baseCtx());
    const cIdx = resume.agentPrompt.indexOf('Continue Here');
    const rIdx = resume.agentPrompt.indexOf('Required Reading');
    assert.ok(cIdx >= 0 && rIdx >= 0 && cIdx < rIdx, 'handoff ahead of required reading on resume');
    assert.equal(readMarker(), true, 'marker set on resume inject');

    // First successful advance clears the handoff.
    contextInject.clearResumeHandoff(baseCtx());
    assert.equal(handoff.readHandoff(ticket), null, 'handoff cleared after first advance');
    assert.notEqual(readMarker(), true, 'marker cleared after first advance');

    // Subsequent steps see no handoff and no marker — narrative is not replayed.
    const later = { step: 'spec', agentPrompt: '' };
    reg.run('spec', later, baseCtx());
    assert.doesNotMatch(later.agentPrompt, /Continue Here/, 'no re-injection into later steps');
  });
});

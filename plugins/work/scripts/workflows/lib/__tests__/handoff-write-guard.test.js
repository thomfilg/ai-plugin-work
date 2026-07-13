/**
 * handoff-write-guard.test.js — Task 8 (GH-315)
 *
 * Confirms that `.continue-here.md` (the pause-work / PreCompact handoff
 * artifact) is NOT caught by the artifact write-guard: a write to
 * `$TASKS_BASE/<TICKET>/.continue-here.md` from the pause-work/PreCompact
 * context must be permitted (the guard returns allow), while the
 * `.work-state.json`-class protection for the real production artifacts
 * (brief.md/spec.md/tasks.md) stays intact.
 *
 * Uses the REAL production artifact rules from `buildArtifactRules` so the
 * test pins the actual guard surface, not a hand-rolled fixture.
 *
 * Run: node --test lib/__tests__/handoff-write-guard.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createArtifactProtector } = require('../protect-artifact-files');
const { buildArtifactRules } = require('../../work/workflow-def/artifact-rules');

const TICKET = 'GH-315';
const HANDOFF = '.continue-here.md';

// The real /work step ids used by buildArtifactRules. Only the keys that the
// rules reference need to be present.
const STEPS = {
  brief: 'brief',
  brief_gate: 'brief_gate',
  spec: 'spec',
  spec_gate: 'spec_gate',
  tasks: 'tasks',
  tasks_gate: 'tasks_gate',
  task_review: 'task_review',
  commit: 'commit',
  check: 'check',
  follow_up: 'follow_up',
};

// workRoot is only touched lazily by the contentGuards, which never run for
// `.continue-here.md` (no rule matches), so a plausible path is fine.
const WORK_ROOT = require('path').join(__dirname, '..', '..', 'work');

/**
 * Build a protector wired to the REAL production artifact rules, in the
 * pause-work / PreCompact context (implement step in progress, no agent
 * gating identity available — the write comes from the in-session agent or
 * the PreCompact hook, neither of which is an authorized report agent).
 */
function makeProductionProtector({ currentStep = 'implement' } = {}) {
  return createArtifactProtector({
    artifacts: buildArtifactRules({ STEPS, workRoot: WORK_ROOT }),
    getStepInProgress: () => currentStep,
    // Pause/PreCompact context is not an authorized report agent.
    isRunningInAgent: () => false,
    getTicketId: () => TICKET,
  });
}

describe('handoff write-guard (.continue-here.md)', () => {
  it('permits a direct Write to .continue-here.md from the pause/PreCompact context', () => {
    const p = makeProductionProtector();
    const result = p.check('Write', {
      file_path: `/tasks/${TICKET}/${HANDOFF}`,
      content: '## Decisions made (and why)\n\n## Blockers / warnings\n\n## What was in flight\n',
    });
    assert.equal(result.blocked, false, 'writing .continue-here.md must be permitted');
  });

  it('permits an Edit of an existing .continue-here.md from the pause context', () => {
    const p = makeProductionProtector();
    const result = p.check('Edit', {
      file_path: `/tasks/${TICKET}/${HANDOFF}`,
      old_string: 'old',
      new_string: 'new',
    });
    assert.equal(result.blocked, false, 'editing .continue-here.md must be permitted');
  });

  it('permits a Bash redirect write to .continue-here.md', () => {
    const p = makeProductionProtector();
    const result = p.check('Bash', {
      command: `printf '%s' "$BODY" > /tasks/${TICKET}/${HANDOFF}`,
    });
    assert.equal(result.blocked, false, 'bash-writing .continue-here.md must be permitted');
  });

  it('still blocks a brief.md write outside the brief step (protection intact)', () => {
    const p = makeProductionProtector({ currentStep: 'implement' });
    const result = p.check('Write', {
      file_path: `/tasks/${TICKET}/brief.md`,
      content: 'tampered brief',
    });
    assert.equal(result.blocked, true, 'brief.md protection must remain intact');
  });
});

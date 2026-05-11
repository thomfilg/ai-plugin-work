/**
 * Tests for policies/state-protection.js
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/state-protection.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  buildBasenameToHintMap,
  createStateFileProtector,
  createFollowUpStateProtector,
} = require('../state-protection');

const STEPS_STUB = { follow_up: 'follow_up' };

const FAKE_WORKFLOWS = [
  {
    name: 'work',
    stateFile: '.work-state.json',
    evidenceFile: '.work-evidence.json',
    transitionHint: 'node work-orchestrator.js transition',
  },
  {
    name: 'work-pr',
    stateFile: '.work-pr.workflow-state.json',
    evidenceFile: '.work-pr.evidence.json',
    transitionHint: 'node work-pr-orchestrator.js transition',
  },
];

describe('state-protection: buildBasenameToHintMap', () => {
  it('maps both stateFile and evidenceFile basenames to the workflow hint', () => {
    const map = buildBasenameToHintMap(FAKE_WORKFLOWS);
    assert.equal(map['.work-state.json'], 'node work-orchestrator.js transition');
    assert.equal(map['.work-evidence.json'], 'node work-orchestrator.js transition');
    assert.equal(map['.work-pr.workflow-state.json'], 'node work-pr-orchestrator.js transition');
  });

  it('handles empty workflows array', () => {
    assert.deepEqual(buildBasenameToHintMap([]), {});
  });
});

describe('state-protection: createStateFileProtector', () => {
  // Minimal protectedBasenames including a target file
  const protectedBasenames = new Set(['.work-state.json']);

  // Stub trustedDirs with the policies dir so realpathSync can resolve real files
  const trustedDirs = [path.resolve(__dirname, '..')];
  const realScript = path.resolve(__dirname, '..', 'state-protection.js');

  it('blocks Edit on a protected basename', () => {
    const protector = createStateFileProtector({
      protectedBasenames,
      exemptScripts: new Set(),
      safeSubcommands: {},
      trustedDirs,
    });
    const r = protector.check('Edit', { file_path: '/some/path/.work-state.json' });
    assert.equal(r.blocked, true);
    assert.equal(r.match, '.work-state.json');
  });

  it('blocks Bash redirect into a protected basename', () => {
    const protector = createStateFileProtector({
      protectedBasenames,
      exemptScripts: new Set(),
      safeSubcommands: {},
      trustedDirs,
    });
    const r = protector.check('Bash', { command: 'echo "x" > .work-state.json' });
    assert.equal(r.blocked, true);
  });

  it('allows Bash invoking exempt script in trusted dir with safe sub-command', () => {
    const protector = createStateFileProtector({
      protectedBasenames,
      exemptScripts: new Set(['state-protection.js']),
      safeSubcommands: { 'state-protection.js': new Set(['get']) },
      trustedDirs,
    });
    const r = protector.check('Bash', {
      command: `node ${realScript} get GH-1`,
    });
    assert.equal(r.blocked, false);
  });

  it('blocks exempt script when sub-command is unsafe', () => {
    const protector = createStateFileProtector({
      protectedBasenames,
      exemptScripts: new Set(['state-protection.js']),
      safeSubcommands: { 'state-protection.js': new Set(['get']) },
      trustedDirs,
    });
    // Actual write attempt with disallowed sub-command — should NOT be exempt,
    // so the underlying file protector still blocks the write redirect
    const r = protector.check('Bash', {
      command: `node ${realScript} set-step && echo x > .work-state.json`,
    });
    assert.equal(r.blocked, true);
  });
});

describe('state-protection: createFollowUpStateProtector', () => {
  // Build a protector with stubbed dependencies so we don't depend on FS state
  function build(opts = {}) {
    return createFollowUpStateProtector({
      getTicketId: opts.getTicketId || (() => 'GH-1'),
      loadStateFile: opts.loadStateFile || (() => null),
      isRunningInAgent: opts.isRunningInAgent || (() => false),
      STEPS: STEPS_STUB,
    });
  }

  it('does not match non-follow-up file basenames', () => {
    const p = build();
    const r = p.check('Edit', { file_path: '/some/.work-state.json' });
    assert.equal(r.blocked, false);
  });

  it('is fail-open when no ticket context', () => {
    const p = build({ getTicketId: () => null });
    const r = p.check('Edit', { file_path: '/x/follow-up-pr-foo.json' });
    assert.equal(r.blocked, false);
  });

  it('blocks when follow_up step is in_progress and caller is not the agent', () => {
    const p = build({
      loadStateFile: () => ({ stepStatus: { follow_up: 'in_progress' } }),
      isRunningInAgent: () => false,
    });
    const r = p.check('Edit', { file_path: '/x/follow-up-pr-foo.json' }, {});
    assert.equal(r.blocked, true);
  });

  it('allows when caller IS the follow-up agent', () => {
    const p = build({
      loadStateFile: () => ({ stepStatus: { follow_up: 'in_progress' } }),
      isRunningInAgent: () => true,
    });
    const r = p.check('Edit', { file_path: '/x/follow-up-pr-foo.json' }, {});
    assert.equal(r.blocked, false);
  });

  it('blocks when follow_up step is not in_progress (no agent)', () => {
    // When follow_up is not in_progress, any direct write is blocked.
    // Defense-in-depth: only the follow_up step + follow-up-pr agent combo is exempt.
    const p = build({
      loadStateFile: () => ({ stepStatus: { follow_up: 'pending' } }),
    });
    const r = p.check('Edit', { file_path: '/x/follow-up-pr-foo.json' }, {});
    assert.equal(r.blocked, true);
  });
});

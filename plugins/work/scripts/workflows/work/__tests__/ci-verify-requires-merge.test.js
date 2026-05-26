/**
 * ci-verify-requires-merge.test.js
 *
 * Defense-in-depth gate for the `ci` step: verify() must require BOTH
 *   1) CI checks passing (existing behavior), AND
 *   2) PR state === 'MERGED' on the remote.
 *
 * Background (third attempt to fix this bug class): the top-level workflow's
 * ci verify previously only consulted `checkCI(...).status === 'passing'`, so
 * `transition-step.js` would happily walk ci → cleanup → reports → complete
 * the moment CI went green, regardless of whether the PR had actually been
 * merged. The `wait_merge` sub-phase exists but lives in a parallel state
 * machine that this verify never consulted.
 *
 * This test pins the new behavior: verify() returns false until the remote
 * reports MERGED, and only then returns true.
 */
'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');

describe('ci verify gate: requires PR MERGED (not just CI passing)', () => {
  let tmpDir;
  let ticketId;
  let ciGate;
  let waitMergeModule;
  let originalFetchPrState;

  const followUpPrPath = path.resolve(__dirname, '..', 'scripts', 'follow-up-pr.js');
  const waitMergePath = path.resolve(
    __dirname,
    '..',
    '..',
    'work-ci',
    'lib',
    'phases',
    'wait_merge.js'
  );

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-verify-merge-'));
    ticketId = 'GH-CI-VERIFY';
    fs.mkdirSync(path.join(tmpDir, ticketId), { recursive: true });

    const stub = new Module(followUpPrPath);
    stub.filename = followUpPrPath;
    stub.loaded = true;
    stub.exports = {
      getPRInfo: () => ({ number: 4242 }),
      checkCI: () => ({ status: 'passing' }),
    };
    require.cache[followUpPrPath] = stub;

    waitMergeModule = require(waitMergePath);
    originalFetchPrState = waitMergeModule.fetchPrState;

    const createWorkflowDefinition = require(path.join(__dirname, '..', 'workflow-definition'));
    const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));
    const { workflow } = createWorkflowDefinition({
      TASKS_BASE: tmpDir,
      safeTicketPath: (id) => id,
      resolveGitHead: () => `ref: refs/heads/${ticketId}-test`,
    });

    ciGate = workflow.commandMap.find((g) => g.step === STEPS.ci && typeof g.verify === 'function');
    assert.ok(ciGate, 'ci verify gate must exist in commandMap');
  });

  after(() => {
    waitMergeModule.fetchPrState = originalFetchPrState;
    delete require.cache[followUpPrPath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    waitMergeModule.fetchPrState = originalFetchPrState;
  });

  it('returns false when CI is passing but PR is OPEN (not yet merged)', () => {
    waitMergeModule.fetchPrState = () => ({ state: 'OPEN', mergedAt: null, mergeCommit: null });
    const result = ciGate.verify(ticketId);
    assert.equal(result, false, 'ci verify must NOT pass until PR is MERGED');
  });

  it('returns false when CI is passing but PR is CLOSED (not merged)', () => {
    waitMergeModule.fetchPrState = () => ({ state: 'CLOSED', mergedAt: null, mergeCommit: null });
    const result = ciGate.verify(ticketId);
    assert.equal(result, false, 'ci verify must NOT pass for a CLOSED-not-merged PR');
  });

  it('returns false when fetchPrState returns null (gh failure)', () => {
    waitMergeModule.fetchPrState = () => null;
    const result = ciGate.verify(ticketId);
    assert.equal(result, false, 'ci verify must fail-closed when merge state unknown');
  });

  it('returns true when CI is passing AND PR state is MERGED', () => {
    waitMergeModule.fetchPrState = () => ({
      state: 'MERGED',
      mergedAt: '2026-05-25T18:00:00Z',
      mergeCommit: { oid: 'deadbeef' },
    });
    const result = ciGate.verify(ticketId);
    assert.equal(result, true, 'ci verify must pass when both CI green AND PR merged');
  });
});

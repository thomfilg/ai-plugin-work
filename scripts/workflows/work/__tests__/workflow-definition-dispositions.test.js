/**
 * workflow-definition-dispositions.test.js
 *
 * GH-286 Task 6: Verify the follow_up step's verify() gate accepts the
 * extended disposition vocabulary required for the bot-review fix-loop
 * fix (R5, R17).
 *
 * The gate at workflow-definition.js:677 currently accepts only:
 *   ['addressed', 'acknowledged', 'outdated']
 *
 * This test asserts the gate also accepts the five new dispositions:
 *   - RESOLVED_BY_CODE_CHANGE
 *   - RESOLVED_BY_AGENT
 *   - STILL_BLOCKING
 *   - NOT_APPLICABLE
 *   - DEFERRED_TO_HUMAN
 *
 * and that a near-miss typo (DEFERRED_TO_HUMANS) is still rejected.
 *
 * Pattern mirrors follow-up-verify-gate.test.js (GH-285): stub
 * isPRGateReady, instantiate the workflow with a temp TASKS_BASE,
 * write fixture review-accountability.json, invoke the gate.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

describe('follow_up verify gate: extended disposition vocabulary (GH-286 Task 6)', { skip: 'deferred to #411 (Task 6 source not implemented)' }, () => {
  let tmpDir;
  let ticketId;
  let followUpGate;
  let accountabilityFile;

  const NEW_DISPOSITIONS = [
    'RESOLVED_BY_CODE_CHANGE',
    'RESOLVED_BY_AGENT',
    'STILL_BLOCKING',
    'NOT_APPLICABLE',
    'DEFERRED_TO_HUMAN',
  ];

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh286-dispositions-'));
    ticketId = 'GH-286';
    const ticketDir = path.join(tmpDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    accountabilityFile = path.join(ticketDir, 'review-accountability.json');

    // Stub isPRGateReady (single comment expected — keeps fixtures small).
    const followUpPrPath = path.resolve(__dirname, '..', 'scripts', 'follow-up-pr.js');
    const stubModule = new Module(followUpPrPath);
    stubModule.filename = followUpPrPath;
    stubModule.loaded = true;
    stubModule.exports = {
      isPRGateReady: () => ({ ready: true, strictCommentCount: 1 }),
    };
    require.cache[followUpPrPath] = stubModule;

    const createWorkflowDefinition = require(path.join(__dirname, '..', 'workflow-definition'));
    const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));
    const { workflow } = createWorkflowDefinition({
      TASKS_BASE: tmpDir,
      safeTicketPath: (id) => id,
      resolveGitHead: () => 'ref: refs/heads/GH-286-test',
    });
    followUpGate = workflow.commandMap.find(
      (g) => g.step === STEPS.follow_up && typeof g.verify === 'function'
    );
    assert.ok(followUpGate, 'follow_up gate must exist');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const followUpPrPath = path.resolve(__dirname, '..', 'scripts', 'follow-up-pr.js');
    delete require.cache[followUpPrPath];
  });

  beforeEach(() => {
    if (fs.existsSync(accountabilityFile)) fs.unlinkSync(accountabilityFile);
  });

  // One accept-test per new disposition keeps failures pinpointable.
  for (const disposition of NEW_DISPOSITIONS) {
    it(`accepts disposition "${disposition}"`, () => {
      fs.writeFileSync(
        accountabilityFile,
        JSON.stringify([{ disposition, reason: `triaged as ${disposition}` }])
      );
      const result = followUpGate.verify(ticketId);
      assert.equal(result, true, `Gate should accept disposition "${disposition}"`);
    });
  }

  it('still accepts the legacy vocabulary (addressed/acknowledged/outdated) for back-compat', () => {
    fs.writeFileSync(
      accountabilityFile,
      JSON.stringify([{ disposition: 'addressed', reason: 'Fixed in latest commit' }])
    );
    assert.equal(followUpGate.verify(ticketId), true);
  });

  it('rejects a typo near-miss disposition (DEFERRED_TO_HUMANS)', () => {
    fs.writeFileSync(
      accountabilityFile,
      JSON.stringify([{ disposition: 'DEFERRED_TO_HUMANS', reason: 'typo' }])
    );
    const result = followUpGate.verify(ticketId);
    assert.equal(result, false, 'Gate must reject unknown dispositions even if close to a valid one');
  });

  it('exports ALLOWED_DISPOSITIONS containing every new and legacy value (refactor surface)', { skip: 'deferred to #411 (Task 6 source not implemented)' }, () => {
    // REFACTOR step (6.1.3) extracts the constant to a named export so the
    // accountability hook can reuse it. Asserting the export now keeps RED
    // green-after-refactor without an extra test file.
    const mod = require(path.join(__dirname, '..', 'workflow-definition'));
    const exported = mod.ALLOWED_DISPOSITIONS;
    assert.ok(Array.isArray(exported), 'ALLOWED_DISPOSITIONS must be an exported array');
    for (const d of [...NEW_DISPOSITIONS, 'addressed', 'acknowledged', 'outdated']) {
      assert.ok(exported.includes(d), `ALLOWED_DISPOSITIONS must contain "${d}"`);
    }
  });
});

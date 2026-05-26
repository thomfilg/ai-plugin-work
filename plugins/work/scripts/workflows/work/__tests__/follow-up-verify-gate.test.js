/**
 * follow-up-verify-gate.test.js
 *
 * GH-285 Task 1: Verify the follow_up step's verify() gate accepts
 * `acknowledged` entries WITHOUT requiring `userApproval === true`.
 *
 * The verify gate delegates to isPRGateReady() for CI/review checks,
 * then validates review-accountability.json entries. Previously,
 * entries with disposition "acknowledged" also required userApproval.
 * This test ensures that requirement is removed.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

describe('follow_up verify gate: acknowledged entries without userApproval', () => {
  let tmpDir;
  let ticketId;
  let workflow;
  let followUpGate;

  before(() => {
    // Create temp tasks base with ticket directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh285-verify-gate-'));
    ticketId = 'GH-285';
    const ticketDir = path.join(tmpDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });

    // Stub isPRGateReady via module cache override
    const followUpPrPath = path.resolve(__dirname, '..', 'scripts', 'follow-up-pr.js');

    // Cache a stub module for follow-up-pr.js
    const stubModule = new Module(followUpPrPath);
    stubModule.filename = followUpPrPath;
    stubModule.loaded = true;
    stubModule.exports = {
      isPRGateReady: () => ({ ready: true, strictCommentCount: 2 }),
    };
    require.cache[followUpPrPath] = stubModule;

    // Create the workflow definition with our temp TASKS_BASE
    const createWorkflowDefinition = require(path.join(__dirname, '..', 'workflow-definition'));
    const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));

    const result = createWorkflowDefinition({
      TASKS_BASE: tmpDir,
      safeTicketPath: (id) => id,
      resolveGitHead: () => 'ref: refs/heads/GH-285-test',
    });

    workflow = result.workflow;

    // Find the follow_up gate in commandMap
    followUpGate = workflow.commandMap.find(
      (g) => g.step === STEPS.follow_up && typeof g.verify === 'function'
    );
    assert.ok(followUpGate, 'follow_up gate must exist');
    assert.ok(typeof followUpGate.verify === 'function', 'verify must be a function');
  });

  after(() => {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Remove the stubbed module from cache
    const followUpPrPath = path.resolve(__dirname, '..', 'scripts', 'follow-up-pr.js');
    delete require.cache[followUpPrPath];
  });

  beforeEach(() => {
    // Ensure clean accountability file state before each test
    const accountabilityFile = path.join(tmpDir, ticketId, 'review-accountability.json');
    if (fs.existsSync(accountabilityFile)) {
      fs.unlinkSync(accountabilityFile);
    }
  });

  it('returns true for acknowledged entries WITHOUT userApproval field', () => {
    const accountabilityFile = path.join(tmpDir, ticketId, 'review-accountability.json');
    const entries = [
      { disposition: 'acknowledged', reason: 'Comment noted, no code change needed' },
      { disposition: 'addressed', reason: 'Fixed in latest commit' },
    ];
    fs.writeFileSync(accountabilityFile, JSON.stringify(entries));

    const result = followUpGate.verify(ticketId);
    assert.equal(result, true, 'Gate should pass for acknowledged entries without userApproval');
  });

  it('returns true for acknowledged entries with userApproval: false', () => {
    const accountabilityFile = path.join(tmpDir, ticketId, 'review-accountability.json');
    const entries = [
      { disposition: 'acknowledged', reason: 'Will address in follow-up', userApproval: false },
      { disposition: 'addressed', reason: 'Fixed' },
    ];
    fs.writeFileSync(accountabilityFile, JSON.stringify(entries));

    const result = followUpGate.verify(ticketId);
    assert.equal(
      result,
      true,
      'Gate should pass for acknowledged entries even with userApproval: false'
    );
  });

  it('still returns true for acknowledged entries with userApproval: true', () => {
    const accountabilityFile = path.join(tmpDir, ticketId, 'review-accountability.json');
    const entries = [
      { disposition: 'acknowledged', reason: 'Approved by user', userApproval: true },
      { disposition: 'addressed', reason: 'Fixed' },
    ];
    fs.writeFileSync(accountabilityFile, JSON.stringify(entries));

    const result = followUpGate.verify(ticketId);
    assert.equal(result, true, 'Gate should still pass when userApproval is true');
  });

  it('still rejects entries missing disposition or reason', () => {
    const accountabilityFile = path.join(tmpDir, ticketId, 'review-accountability.json');
    const entries = [
      { disposition: 'acknowledged' }, // missing reason
      { disposition: 'addressed', reason: 'Fixed' },
    ];
    fs.writeFileSync(accountabilityFile, JSON.stringify(entries));

    const result = followUpGate.verify(ticketId);
    assert.equal(result, false, 'Gate should reject entries missing reason');
  });

  it('still rejects when entry count < strictCommentCount', () => {
    const accountabilityFile = path.join(tmpDir, ticketId, 'review-accountability.json');
    const entries = [
      { disposition: 'addressed', reason: 'Fixed' },
      // Only 1 entry but strictCommentCount is 2
    ];
    fs.writeFileSync(accountabilityFile, JSON.stringify(entries));

    const result = followUpGate.verify(ticketId);
    assert.equal(result, false, 'Gate should reject when fewer entries than strictCommentCount');
  });
});

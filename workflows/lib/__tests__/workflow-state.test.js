/**
 * Tests for workflow-state.js
 *
 * Run with: node --test lib/__tests__/workflow-state.test.js
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { WorkflowState } = require('../workflow-state');

const TEST_BASE = path.join(os.tmpdir(), 'workflow-state-test-' + process.pid);
const STEPS = ['1_parse', '2_draft', '3_review', '4_publish'];

describe('WorkflowState', () => {
  let ws;
  const INSTANCE = 'test-instance';

  before(() => {
    fs.mkdirSync(TEST_BASE, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  });

  afterEach(() => {
    // Clean up instance directories between tests
    const instanceDir = path.join(TEST_BASE, INSTANCE);
    fs.rmSync(instanceDir, { recursive: true, force: true });
  });

  // Fresh WorkflowState for each test pointing at temp dir
  function createWs() {
    return new WorkflowState('test-workflow', TEST_BASE);
  }

  // ─── init() ───────────────────────────────────────────────────────────────────

  describe('init()', () => {
    it('creates state file with all steps as pending', () => {
      ws = createWs();
      const state = ws.init(INSTANCE, STEPS);

      assert.strictEqual(state.workflow, 'test-workflow');
      assert.strictEqual(state.instanceId, INSTANCE);
      assert.strictEqual(state.status, 'in_progress');
      assert.strictEqual(state.currentStep, 1);
      assert.deepStrictEqual(state.errors, []);
      assert.ok(state.startTime);
      assert.ok(state.lastUpdate);

      // All steps should be pending
      for (const step of STEPS) {
        assert.strictEqual(state.stepStatus[step], 'pending');
      }

      // State file should exist on disk
      const filePath = path.join(TEST_BASE, INSTANCE, '.workflow-state.json');
      assert.ok(fs.existsSync(filePath));
    });
  });

  // ─── load() ───────────────────────────────────────────────────────────────────

  describe('load()', () => {
    it('returns null for nonexistent instance', () => {
      ws = createWs();
      const result = ws.load('does-not-exist');
      assert.strictEqual(result, null);
    });

    it('returns parsed JSON for existing state', () => {
      ws = createWs();
      ws.init(INSTANCE, STEPS);

      const loaded = ws.load(INSTANCE);
      assert.strictEqual(loaded.workflow, 'test-workflow');
      assert.strictEqual(loaded.instanceId, INSTANCE);
      assert.strictEqual(loaded.status, 'in_progress');
      assert.deepStrictEqual(Object.keys(loaded.stepStatus), STEPS);
    });

    it('returns null for corrupt JSON in state file', () => {
      ws = createWs();
      // Create the instance directory and write corrupt JSON
      const instanceDir = path.join(TEST_BASE, INSTANCE);
      fs.mkdirSync(instanceDir, { recursive: true });
      fs.writeFileSync(path.join(instanceDir, '.workflow-state.json'), '{not valid json!!!');

      const result = ws.load(INSTANCE);
      assert.strictEqual(result, null);
    });

    it('handles missing lastUpdate field in legacy state files', () => {
      ws = createWs();
      // Write a state file without lastUpdate (simulating a legacy format)
      const instanceDir = path.join(TEST_BASE, INSTANCE);
      fs.mkdirSync(instanceDir, { recursive: true });
      const legacyState = {
        workflow: 'test-workflow',
        instanceId: INSTANCE,
        status: 'in_progress',
        currentStep: 1,
        stepStatus: { '1_parse': 'completed', '2_draft': 'pending' },
        errors: [],
        startTime: '2025-01-01T00:00:00.000Z',
      };
      fs.writeFileSync(
        path.join(instanceDir, '.workflow-state.json'),
        JSON.stringify(legacyState, null, 2),
      );

      const loaded = ws.load(INSTANCE);
      assert.ok(loaded, 'load() should return the state object');
      assert.strictEqual(loaded.workflow, 'test-workflow');
      assert.strictEqual(loaded.lastUpdate, undefined);
      assert.strictEqual(loaded.stepStatus['1_parse'], 'completed');
    });
  });

  // ─── save() ───────────────────────────────────────────────────────────────────

  describe('save()', () => {
    it('writes state file and adds lastUpdate timestamp', () => {
      ws = createWs();
      const state = {
        workflow: 'test-workflow',
        instanceId: INSTANCE,
        status: 'in_progress',
        currentStep: 1,
        stepStatus: { '1_parse': 'pending' },
        errors: [],
      };

      const beforeSave = new Date().toISOString();
      const saved = ws.save(INSTANCE, state);
      const afterSave = new Date().toISOString();

      assert.ok(saved.lastUpdate, 'lastUpdate should be set');
      assert.ok(saved.lastUpdate >= beforeSave, 'lastUpdate should be >= time before save');
      assert.ok(saved.lastUpdate <= afterSave, 'lastUpdate should be <= time after save');

      // Verify it was written to disk
      const filePath = path.join(TEST_BASE, INSTANCE, '.workflow-state.json');
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.strictEqual(onDisk.lastUpdate, saved.lastUpdate);
    });

    (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
      ? it.skip : it)('handles EACCES permission error on state directory gracefully', () => {
      ws = createWs();
      // Point to a directory we cannot write to
      const readOnlyDir = path.join(TEST_BASE, 'readonly-dir');
      fs.mkdirSync(readOnlyDir, { recursive: true });
      fs.chmodSync(readOnlyDir, 0o444);

      const readOnlyWs = new WorkflowState('test-workflow', readOnlyDir);
      const state = {
        workflow: 'test-workflow',
        instanceId: 'blocked',
        status: 'in_progress',
        stepStatus: {},
        errors: [],
      };

      assert.throws(() => {
        readOnlyWs.save('blocked', state);
      }, (err) => {
        // Should throw a filesystem error (EACCES or EPERM depending on OS)
        return err.code === 'EACCES' || err.code === 'EPERM';
      });

      // Restore permissions so cleanup works
      fs.chmodSync(readOnlyDir, 0o755);
    });
  });

  // ─── setStepStatus() ─────────────────────────────────────────────────────────

  describe('setStepStatus()', () => {
    it('updates step and currentStep pointer', () => {
      ws = createWs();
      ws.init(INSTANCE, STEPS);

      const updated = ws.setStepStatus(INSTANCE, '2_draft', 'in_progress');
      assert.strictEqual(updated.stepStatus['2_draft'], 'in_progress');
      assert.strictEqual(updated.currentStep, 2);

      // Verify other steps remain unchanged
      assert.strictEqual(updated.stepStatus['1_parse'], 'pending');
      assert.strictEqual(updated.stepStatus['3_review'], 'pending');
    });

    it('throws on nonexistent instance', () => {
      ws = createWs();

      assert.throws(
        () => ws.setStepStatus('ghost-instance', '1_parse', 'in_progress'),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('ghost-instance'));
          return true;
        },
      );
    });
  });

  // ─── complete() ───────────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('marks all steps completed and sets completedTime', () => {
      ws = createWs();
      ws.init(INSTANCE, STEPS);
      ws.setStepStatus(INSTANCE, '1_parse', 'completed');
      ws.setStepStatus(INSTANCE, '2_draft', 'in_progress');

      const beforeComplete = new Date().toISOString();
      const result = ws.complete(INSTANCE);
      const afterComplete = new Date().toISOString();

      assert.strictEqual(result.status, 'completed');
      assert.ok(result.completedTime);
      assert.ok(result.completedTime >= beforeComplete);
      assert.ok(result.completedTime <= afterComplete);

      // Every step should now be completed
      for (const step of STEPS) {
        assert.strictEqual(result.stepStatus[step], 'completed');
      }
    });
  });

  // ─── getCurrentStep() ────────────────────────────────────────────────────────

  describe('getCurrentStep()', () => {
    it('returns first in_progress step', () => {
      ws = createWs();
      ws.init(INSTANCE, STEPS);
      ws.setStepStatus(INSTANCE, '1_parse', 'completed');
      ws.setStepStatus(INSTANCE, '2_draft', 'in_progress');

      const current = ws.getCurrentStep(INSTANCE);
      assert.strictEqual(current, '2_draft');
    });

    it('returns first non-completed step if none in_progress', () => {
      ws = createWs();
      ws.init(INSTANCE, STEPS);
      ws.setStepStatus(INSTANCE, '1_parse', 'completed');
      // All others remain pending, none are in_progress

      const current = ws.getCurrentStep(INSTANCE);
      assert.strictEqual(current, '2_draft');
    });

    it('returns last step if all completed', () => {
      ws = createWs();
      ws.init(INSTANCE, STEPS);
      ws.complete(INSTANCE);

      const current = ws.getCurrentStep(INSTANCE);
      assert.strictEqual(current, '4_publish');
    });
  });

  // ─── getResumeInfo() ─────────────────────────────────────────────────────────

  describe('getResumeInfo()', () => {
    it('returns { exists: false } for nonexistent instance', () => {
      ws = createWs();
      const info = ws.getResumeInfo('no-such-instance');
      assert.deepStrictEqual(info, { exists: false });
    });

    it('returns resume step, completed count, and last error', () => {
      ws = createWs();
      ws.init(INSTANCE, STEPS);
      ws.setStepStatus(INSTANCE, '1_parse', 'completed');
      ws.setStepStatus(INSTANCE, '2_draft', 'in_progress');
      ws.addError(INSTANCE, '2_draft', 'draft generation failed');

      const info = ws.getResumeInfo(INSTANCE);

      assert.strictEqual(info.exists, true);
      assert.strictEqual(info.workflow, 'test-workflow');
      assert.strictEqual(info.instanceId, INSTANCE);
      assert.strictEqual(info.status, 'in_progress');
      assert.strictEqual(info.resumeStep, '2_draft');
      assert.strictEqual(info.resumeStepIndex, 2);
      assert.deepStrictEqual(info.completedSteps, ['1_parse']);
      assert.ok(info.lastError);
      assert.strictEqual(info.lastError.step, '2_draft');
      assert.strictEqual(info.lastError.error, 'draft generation failed');
      assert.ok(info.lastUpdate);
    });
  });

  // ─── formatState() ────────────────────────────────────────────────────────────

  describe('formatState()', () => {
    it('returns human-readable output with status icons', () => {
      ws = createWs();
      ws.init(INSTANCE, STEPS);
      ws.setStepStatus(INSTANCE, '1_parse', 'completed');
      ws.setStepStatus(INSTANCE, '2_draft', 'in_progress');
      ws.addError(INSTANCE, '2_draft', 'something went wrong');

      const output = ws.formatState(INSTANCE);

      // Header info
      assert.ok(output.includes('test-workflow'), 'should contain workflow name');
      assert.ok(output.includes(INSTANCE), 'should contain instance ID');
      assert.ok(output.includes('Status:'), 'should contain Status label');
      assert.ok(output.includes('Current Step:'), 'should contain Current Step label');
      assert.ok(output.includes('Steps:'), 'should contain Steps label');

      // Status icons (completed, in_progress, pending)
      assert.ok(output.includes('\u2705'), 'should contain completed icon');  // checkmark
      assert.ok(output.includes('\uD83D\uDD04'), 'should contain in_progress icon');  // arrows
      assert.ok(output.includes('\u23F3'), 'should contain pending icon');    // hourglass

      // Step names
      assert.ok(output.includes('1_parse'), 'should list 1_parse step');
      assert.ok(output.includes('2_draft'), 'should list 2_draft step');
      assert.ok(output.includes('3_review'), 'should list 3_review step');
      assert.ok(output.includes('4_publish'), 'should list 4_publish step');

      // Error section
      assert.ok(output.includes('Recent Errors:'), 'should contain errors section');
      assert.ok(output.includes('something went wrong'), 'should contain error message');
    });

    it('returns "No state found" for nonexistent instance', () => {
      ws = createWs();
      const output = ws.formatState('nonexistent');
      assert.strictEqual(output, 'No state found');
    });
  });
});

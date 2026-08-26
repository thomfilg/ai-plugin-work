'use strict';

/**
 * state-durable-before-wait.test.js
 *
 * `monitor` blocks inside this process while CI runs — the skill says "up to
 * 40 attempts with adaptive intervals … CI can take 20+ minutes". A run killed
 * during that wait (harness command timeout, closed terminal) used to leave
 * NOTHING on disk: `--init` deletes `.follow-up-state.json` up front and
 * `.follow-up-next.json` is only written after the instruction is produced. So
 * the documented state-file-first recovery ("read `.follow-up-state.json` /
 * `.follow-up-next.json`") had nothing to read, and the status bar had nothing
 * to show.
 *
 * The orchestrator now persists the starting state before the first step runs.
 * A step that dies mid-wait is simulated here by a step registry that throws.
 *
 * Run: node --test workflows/follow-up/__tests__/state-durable-before-wait.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TICKET = 'TEST-FU-DURABLE';

let tasksBase;
let followUpNext;

describe('follow-up state is durable before the CI wait', () => {
  before(() => {
    tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-durable-'));
    process.env.TASKS_BASE = tasksBase;
    process.env.WORKTREES_BASE = tasksBase;
    process.env.REPO_NAME = 'repo';

    // Stub the step registry BEFORE follow-up-next.js loads it: runStep throws
    // the way a killed monitor wait leaves the process — mid-step, before any
    // instruction exists to persist.
    const registryPath = require.resolve('../lib/step-registry');
    require.cache[registryPath] = {
      id: registryPath,
      filename: registryPath,
      loaded: true,
      exports: {
        STEPS: ['monitor', 'triage', 'report'],
        runStep: () => {
          throw new Error('SIGTERM during the CI wait');
        },
        dispatchStepResult: () => {},
      },
    };

    followUpNext = require('../follow-up-next');
  });

  after(() => {
    fs.rmSync(tasksBase, { recursive: true, force: true });
  });

  it('writes .follow-up-state.json before the first step can die', () => {
    assert.throws(() => followUpNext.getNextInstruction(TICKET, 4242), /SIGTERM/);

    const statePath = path.join(tasksBase, TICKET, '.follow-up-state.json');
    assert.ok(fs.existsSync(statePath), 'a killed run must leave resumable state on disk');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.ticketId, TICKET);
    assert.equal(
      state.prNumber,
      4242,
      'the pinned PR survives so a resume does not re-discover it'
    );
    assert.equal(state.currentStep, 'monitor');
    assert.equal(state.status, 'in_progress');
  });
});

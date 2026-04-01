#!/usr/bin/env node

/**
 * Generic Workflow State Persistence
 *
 * Extracted and generalized from work-state.js.
 * Manages persistent state for any workflow with configurable state directory.
 *
 * Usage (CLI):
 *   node workflow-state.js <workflow> <command> <instanceId> [args...]
 *   node workflow-state.js create-jira init my-slug
 *   node workflow-state.js create-jira get my-slug
 *   node workflow-state.js create-jira set-step my-slug 3_agents in_progress
 *   node workflow-state.js create-jira add-error my-slug 3_agents "agent crashed"
 *   node workflow-state.js create-jira complete my-slug
 *   node workflow-state.js create-jira resume-info my-slug
 *
 * Usage (API):
 *   const { WorkflowState } = require('./workflow-state');
 *   const ws = new WorkflowState('create-jira', 'tasks/drafts');
 *   ws.init('my-slug', ['1_parse', '2_drafts', ...]);
 */

const fs = require('fs');
const path = require('path');

class WorkflowState {
  /**
   * @param {string} workflowName - Unique workflow identifier
   * @param {string} stateDir - Base directory for state files (relative to cwd or absolute)
   */
  constructor(workflowName, stateDir) {
    this.workflowName = workflowName;
    this.stateDir = path.isAbsolute(stateDir) ? stateDir : path.resolve(process.cwd(), stateDir);
  }

  /** Get state file path for an instance */
  _statePath(instanceId) {
    return path.join(this.stateDir, instanceId, '.workflow-state.json');
  }

  /** Load state for an instance (returns null if not found) */
  load(instanceId) {
    const p = this._statePath(instanceId);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }

  /** Save state for an instance */
  save(instanceId, state) {
    const dir = path.join(this.stateDir, instanceId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    state.lastUpdate = new Date().toISOString();
    fs.writeFileSync(this._statePath(instanceId), JSON.stringify(state, null, 2));
    return state;
  }

  /**
   * Initialize a new workflow state
   * @param {string} instanceId
   * @param {string[]} steps - Ordered array of step IDs
   * @param {object} [extraFields] - Additional fields to store in state
   */
  init(instanceId, steps, extraFields = {}) {
    const stepStatus = {};
    steps.forEach(step => { stepStatus[step] = 'pending'; });

    const state = {
      workflow: this.workflowName,
      instanceId,
      status: 'in_progress',
      currentStep: 1,
      stepStatus,
      errors: [],
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      ...extraFields,
    };

    return this.save(instanceId, state);
  }

  /** Set a step's status */
  setStepStatus(instanceId, step, status) {
    let state = this.load(instanceId);
    if (!state) throw new Error(`No state found for instance "${instanceId}"`);

    state.stepStatus[step] = status;

    // Update currentStep pointer when step goes in_progress
    const steps = Object.keys(state.stepStatus);
    const idx = steps.indexOf(step);
    if (status === 'in_progress' && idx >= 0) {
      state.currentStep = idx + 1;
    }

    return this.save(instanceId, state);
  }

  /** Add an error record */
  addError(instanceId, step, error) {
    let state = this.load(instanceId);
    if (!state) throw new Error(`No state found for instance "${instanceId}"`);

    state.errors.push({ step, error, timestamp: new Date().toISOString() });
    return this.save(instanceId, state);
  }

  /** Mark the workflow as complete */
  complete(instanceId) {
    let state = this.load(instanceId);
    if (!state) return { error: 'No state found' };

    state.status = 'completed';
    state.completedTime = new Date().toISOString();
    Object.keys(state.stepStatus).forEach(s => { state.stepStatus[s] = 'completed'; });
    return this.save(instanceId, state);
  }

  /** Get the current step ID from state */
  getCurrentStep(instanceId) {
    const state = this.load(instanceId);
    if (!state?.stepStatus) return null;
    const steps = Object.keys(state.stepStatus);
    for (const step of steps) {
      if (state.stepStatus[step] === 'in_progress') return step;
    }
    for (const step of steps) {
      if (state.stepStatus[step] !== 'completed') return step;
    }
    return steps[steps.length - 1]; // all completed → last step
  }

  /** Get resume info: what step to resume from */
  getResumeInfo(instanceId) {
    const state = this.load(instanceId);
    if (!state) return { exists: false };

    const steps = Object.keys(state.stepStatus);
    let resumeStep = null;
    let resumeStepIndex = 0;

    for (let i = 0; i < steps.length; i++) {
      const status = state.stepStatus[steps[i]];
      if (status === 'in_progress' || status === 'pending') {
        resumeStep = steps[i];
        resumeStepIndex = i + 1;
        break;
      }
    }

    return {
      exists: true,
      workflow: state.workflow,
      instanceId: state.instanceId,
      status: state.status,
      currentStep: state.currentStep,
      resumeStep,
      resumeStepIndex,
      completedSteps: steps.filter(s => state.stepStatus[s] === 'completed'),
      lastError: state.errors.length > 0 ? state.errors[state.errors.length - 1] : null,
      lastUpdate: state.lastUpdate,
    };
  }

  /** Format state for human display */
  formatState(instanceId) {
    const state = this.load(instanceId);
    if (!state) return 'No state found';

    const steps = Object.keys(state.stepStatus);
    let output = `\nWorkflow: ${state.workflow} (${state.instanceId})\n`;
    output += '════════════════════════════════════════════\n';
    output += `Status: ${state.status}\n`;
    output += `Current Step: ${state.currentStep}\n`;
    output += `Started: ${state.startTime}\n`;
    output += `Last Update: ${state.lastUpdate}\n\n`;
    output += 'Steps:\n';

    steps.forEach((step, index) => {
      const status = state.stepStatus[step];
      const icon = status === 'completed' ? '\u2705' :
                   status === 'in_progress' ? '\uD83D\uDD04' :
                   status === 'failed' ? '\u274C' : '\u23F3';
      output += `  ${index + 1}. ${icon} ${step}: ${status}\n`;
    });

    if (state.errors.length > 0) {
      output += '\nRecent Errors:\n';
      state.errors.slice(-3).forEach(err => {
        output += `  - [${err.step}] ${err.error}\n`;
      });
    }

    return output;
  }
}

// ─── CLI handler ──────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const workflowName = args[0];
  const command = args[1];
  const instanceId = args[2];

  if (!workflowName || !command) {
    console.error('Usage: node workflow-state.js <workflow> <command> <instanceId> [args...]');
    console.error('Commands: init, get, set-step, add-error, complete, resume-info');
    process.exit(1);
  }


  // Search plugin workflows first (including subdirectories), then global
  function findWorkflowFile(name) {
    const pluginDir = path.join(__dirname, '..');
    const globalDir = path.join(process.env.HOME || '/home/node', '.claude', 'workflows');
    const fileName = name + '.workflow.js';
    for (const baseDir of [pluginDir, globalDir]) {
      // Check directly in the base dir
      let p = path.join(baseDir, fileName);
      if (fs.existsSync(p)) return p;
      // Check in subdirectory named after the workflow (e.g. workflows/check/check.workflow.js)
      p = path.join(baseDir, name, fileName);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  // Try to load workflow definition to get stateDir, fallback to 'tasks/drafts'
  let stateDir = 'tasks/drafts';
  try {
    const wfPath = findWorkflowFile(workflowName);
    if (wfPath) {
      const wf = require(wfPath);
      stateDir = wf.stateDir || stateDir;
    }
  } catch { /* use default */ }

  const ws = new WorkflowState(workflowName, stateDir);

  switch (command) {
    case 'init': {
      // Need steps — load from workflow definition
      let steps = args[3] ? JSON.parse(args[3]) : null;
      if (!steps) {
        try {
          const wfPath = findWorkflowFile(workflowName);
          if (!wfPath) throw new Error('Not found');
          const wf = require(wfPath);
          steps = wf.steps.map(s => s.id);
        } catch {
          console.error('Cannot determine steps. Pass steps JSON as 4th arg or ensure workflow definition exists.');
          process.exit(1);
        }
      }
      const result = ws.init(instanceId, steps);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'get': {
      const state = ws.load(instanceId);
      if (args[3] === '--format') {
        console.log(ws.formatState(instanceId));
      } else {
        console.log(JSON.stringify(state, null, 2));
      }
      break;
    }
    case 'set-step': {
      const result = ws.setStepStatus(instanceId, args[3], args[4]);
      console.log(JSON.stringify({ success: true, step: args[3], status: args[4] }));
      break;
    }
    case 'add-error': {
      ws.addError(instanceId, args[3], args[4]);
      console.log(JSON.stringify({ success: true, error: 'added' }));
      break;
    }
    case 'complete': {
      const result = ws.complete(instanceId);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'resume-info': {
      const result = ws.getResumeInfo(instanceId);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { WorkflowState };

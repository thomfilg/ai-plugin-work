#!/usr/bin/env node

/**
 * Reusable Workflow Engine for Deterministic Step Execution
 *
 * Loads workflow definitions from plugin workflows/ and global workflows/ and provides:
 * - State machine validation (createStatusTransitions, canTransition)
 * - Step transition recording (forward/backward with intermediate step handling)
 * - Default plan generation using workflow's detectStepState()
 * - CLI interface for plan, transition, transitions, graph, list
 *
 * Usage:
 *   node workflow-engine.js <workflow-name> plan <args...>
 *   node workflow-engine.js <workflow-name> transition <instanceId> <step>
 *   node workflow-engine.js <workflow-name> transitions <instanceId>
 *   node workflow-engine.js <workflow-name> graph
 *   node workflow-engine.js list
 */

const fs = require('fs');
const path = require('path');
const { WorkflowState } = require('./workflow-state');

// Scan both plugin workflows and global workflows (for non-plugin workflows like create-jira)
const PLUGIN_WORKFLOWS_DIR = path.join(__dirname, '..');
const GLOBAL_WORKFLOWS_DIR = path.join(process.env.HOME || '/home/node', '.claude', 'workflows');
const WORKFLOWS_DIR = PLUGIN_WORKFLOWS_DIR; // Primary location

// ─── State Machine ───────────────────────────────────────────────────────────
// Ported from work-orchestrator.js (same pattern as IStateMachine.ts)

/**
 * Build transition map from {source, targets} array.
 * @param {Array<{source: string, targets: string[]}>} transitions
 * @returns {{[key: string]: string[]}}
 */
function createStatusTransitions(transitions) {
  const map = {};
  const defined = new Set(transitions.map((t) => t.source));
  transitions.forEach((t) => {
    map[t.source] = t.targets.filter((target) => defined.has(target) && target !== t.source);
  });
  return map;
}

/**
 * Returns a validator function for checking if a transition is legal.
 * @param {{[key: string]: string[]}} statusTransitions
 * @returns {(current: string, next: string) => boolean}
 */
function canTransition(statusTransitions) {
  return (current, next) => {
    const valid = statusTransitions[current] || [];
    return valid.includes(next);
  };
}

// ─── Workflow Discovery ─────────────────────────────────────────────────────

/** Scan plugin workflows/ and global workflows/ for *.workflow.js files (including subdirectories) */
function discoverWorkflows() {
  const results = [];
  const seen = new Set();
  for (const dir of [PLUGIN_WORKFLOWS_DIR, GLOBAL_WORKFLOWS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    // Scan both the directory itself and one level of subdirectories
    const searchDirs = [dir];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        entry.name !== 'lib' &&
        entry.name !== '__tests__'
      ) {
        searchDirs.push(path.join(dir, entry.name));
      }
    }
    for (const searchDir of searchDirs) {
      for (const f of fs.readdirSync(searchDir).filter((f) => f.endsWith('.workflow.js'))) {
        if (seen.has(f)) continue; // plugin version takes precedence
        seen.add(f);
        try {
          const wf = require(path.join(searchDir, f));
          if (!wf || !wf.name) continue; // Skip non-workflow modules (e.g. CLI-only scripts)
          results.push({
            file: f,
            name: wf.name,
            command: wf.command,
            stateDir: wf.stateDir,
            stepsCount: wf.steps?.length || 0,
          });
        } catch (err) {
          results.push({ file: f, error: err.message });
        }
      }
    }
  }
  return results;
}

/** Load and validate a workflow module by name */
function loadWorkflow(name) {
  const fileName = `${name}.workflow.js`;
  let filePath = null;
  // Search plugin workflows dir and its subdirectories, then global
  for (const baseDir of [PLUGIN_WORKFLOWS_DIR, GLOBAL_WORKFLOWS_DIR]) {
    if (!fs.existsSync(baseDir)) continue;
    // Check directly in the base dir
    const directPath = path.join(baseDir, fileName);
    if (fs.existsSync(directPath)) {
      filePath = directPath;
      break;
    }
    // Check in subdirectory named after the workflow (e.g. workflows/check/check.workflow.js)
    const subDirPath = path.join(baseDir, name, fileName);
    if (fs.existsSync(subDirPath)) {
      filePath = subDirPath;
      break;
    }
  }
  if (!filePath) {
    throw new Error(
      `Workflow "${name}" not found in ${PLUGIN_WORKFLOWS_DIR} or ${GLOBAL_WORKFLOWS_DIR}`
    );
  }
  const wf = require(filePath);

  // Validate required fields
  const required = ['name', 'command', 'stateDir', 'steps', 'transitions'];
  for (const field of required) {
    if (!wf[field]) throw new Error(`Workflow "${name}" missing required field: ${field}`);
  }
  if (!wf.params || typeof wf.params !== 'function') {
    throw new Error(`Workflow "${name}" missing required function: params(args)`);
  }

  return wf;
}

// ─── Default Plan Generator ─────────────────────────────────────────────────

/**
 * Generate a plan using the workflow's detectStepState() for each step.
 * Falls back to PENDING for all steps if detectStepState is not provided.
 */
function defaultPlanGenerator(workflow, instanceId, args, stateInstance) {
  const existingState = stateInstance.load(instanceId);
  const inspectData = workflow.inspect ? workflow.inspect(instanceId) : {};

  const plan = [];
  for (const step of workflow.steps) {
    let action = 'RUN';
    let reason = step.name;
    let command = step.command || null;

    if (workflow.detectStepState) {
      try {
        const detection = workflow.detectStepState(step.id, instanceId, existingState, inspectData);
        if (detection) {
          action = detection.action || action;
          reason = detection.reason || reason;
          if (detection.command !== undefined) command = detection.command;
        }
      } catch (err) {
        reason = `detectStepState error: ${err.message}`;
      }
    } else if (existingState?.stepStatus?.[step.id] === 'completed') {
      action = 'SKIP';
      reason = 'Previously completed';
    }

    plan.push({
      step: step.id,
      name: step.name,
      action,
      ...(command ? { command } : {}),
      reason,
    });
  }

  return plan;
}

// ─── Transition Command ──────────────────────────────────────────────────────

function transitionStep(workflow, stateInstance, instanceId, targetStep) {
  const transitionMap = createStatusTransitions(workflow.transitions);
  const allSteps = workflow.steps.map((s) => s.id);
  const validator = canTransition(transitionMap);

  if (!allSteps.includes(targetStep)) {
    return { error: true, message: `Invalid step: "${targetStep}"`, validSteps: allSteps };
  }

  let ws = stateInstance.load(instanceId);
  const currentStep = stateInstance.getCurrentStep(instanceId) || allSteps[0];

  if (!validator(currentStep, targetStep)) {
    return {
      error: true,
      message: `BLOCKED: ${currentStep} \u2192 ${targetStep}`,
      from: currentStep,
      to: targetStep,
      allowed: transitionMap[currentStep] || [],
      hint: `From ${currentStep} you can go to: ${(transitionMap[currentStep] || []).join(', ') || '(terminal)'}`,
    };
  }

  // Initialize state if needed
  if (!ws) {
    ws = stateInstance.init(instanceId, allSteps);
  }

  // Snapshot state before mutations — used for full rollback if onTransition fails
  const preTransitionState = structuredClone(ws);

  const currentIdx = allSteps.indexOf(currentStep);
  const targetIdx = allSteps.indexOf(targetStep);

  // Mark current as completed, target as in_progress
  ws.stepStatus[currentStep] = 'completed';
  ws.stepStatus[targetStep] = 'in_progress';
  ws.currentStep = targetIdx + 1;

  // Auto-complete workflow when reaching a terminal step (no outgoing transitions)
  const targetTransitions = transitionMap[targetStep] || [];
  if (targetTransitions.length === 0) {
    ws.stepStatus[targetStep] = 'completed';
    ws.status = 'completed';
  }

  if (targetIdx < currentIdx) {
    // Going backward (retry loop) — reset intermediate steps
    for (let i = targetIdx + 1; i <= currentIdx; i++) {
      ws.stepStatus[allSteps[i]] = 'pending';
    }
  } else {
    // Going forward — mark skipped intermediates as completed
    for (let i = currentIdx + 1; i < targetIdx; i++) {
      if (ws.stepStatus[allSteps[i]] === 'pending') {
        ws.stepStatus[allSteps[i]] = 'completed';
      }
    }
  }

  stateInstance.save(instanceId, ws);

  // Invoke workflow's onTransition callback if defined
  if (typeof workflow.onTransition === 'function') {
    try {
      workflow.onTransition(currentStep, targetStep, instanceId, { stateInstance });
    } catch (err) {
      // onTransition failed — full rollback to pre-transition state
      const msg = err?.message || String(err);
      process.stderr.write(`[workflow-engine] onTransition error (rolling back): ${msg}\n`);
      if (err?.stack) process.stderr.write(`[workflow-engine] ${err.stack}\n`);
      stateInstance.save(instanceId, preTransitionState);
      return {
        error: true,
        message: `Transition ${currentStep} → ${targetStep} reverted: onTransition failed — ${msg}`,
        from: currentStep,
        to: targetStep,
        rollback: true,
      }; // full state snapshot restored
    }
  }

  return {
    success: true,
    from: currentStep,
    to: targetStep,
    direction: targetIdx > currentIdx ? 'forward' : 'backward',
    message: `${currentStep} \u2192 ${targetStep}`,
  };
}

function getAvailableTransitions(workflow, stateInstance, instanceId) {
  const transitionMap = createStatusTransitions(workflow.transitions);
  const ws = stateInstance.load(instanceId);
  const current = stateInstance.getCurrentStep(instanceId) || workflow.steps[0]?.id;

  return {
    workflow: workflow.name,
    instanceId,
    currentStep: current,
    status: ws?.stepStatus?.[current] || 'unknown',
    allowed: transitionMap[current] || [],
    allStatuses: ws?.stepStatus || {},
  };
}

// ─── Plan Formatting ─────────────────────────────────────────────────────────

function defaultFormatPlan(workflow, instanceId, plan, summary) {
  const lines = [];

  lines.push('');
  lines.push('\u2550'.repeat(67));
  lines.push(`  WORKFLOW PLAN: ${workflow.name} (${instanceId})`);
  lines.push('\u2550'.repeat(67));
  lines.push('');
  lines.push('  PLAN:');

  for (const step of plan) {
    const icon =
      step.action === 'RUN'
        ? '\uD83D\uDD04'
        : step.action === 'SKIP'
          ? '\u23ED\uFE0F'
          : step.action === 'DEFER'
            ? '\uD83D\uDD2E'
            : step.action === 'BLOCKED'
              ? '\uD83D\uDED1'
              : '\u23F3';
    const cmd = step.command ? ` \u2192 ${step.command}` : '';
    lines.push(`    ${icon} ${step.step.padEnd(20)} ${step.action.padEnd(7)} ${step.reason}${cmd}`);
  }

  lines.push('');
  lines.push(
    `  SUMMARY: ${summary.run} RUN, ${summary.blocked || 0} BLOCKED, ${summary.defer || 0} DEFER, ${summary.skip} SKIP, ${summary.pending} PENDING`
  );
  if (summary.firstAction !== 'none') {
    lines.push(`  FIRST ACTION: ${summary.firstAction}`);
  }
  if (summary.stepsToRun.length > 0) {
    lines.push(`  STEPS TO RUN: ${summary.stepsToRun.join(' \u2192 ')}`);
  }
  if (summary.stepsDeferred && summary.stepsDeferred.length > 0) {
    lines.push(`  STEPS DEFERRED: ${summary.stepsDeferred.join(' \u2192 ')}`);
  }
  if (summary.stepsBlocked && summary.stepsBlocked.length > 0) {
    lines.push(`  STEPS BLOCKED: ${summary.stepsBlocked.join(' \u2192 ')}`);
  }
  lines.push('');
  lines.push('\u2550'.repeat(67));
  lines.push(
    '  INSTRUCTIONS: Execute RUN steps in order. DEFER steps: re-run plan first to resolve to RUN/SKIP.'
  );
  lines.push(`  TRANSITION: node ${__filename} ${workflow.name} transition ${instanceId} <step>`);
  lines.push('\u2550'.repeat(67));
  lines.push('');

  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      JSON.stringify({
        error: true,
        message: 'Usage: workflow-engine.js <workflow-name> <command> [args...] | list',
      })
    );
    process.exit(1);
  }

  // Handle 'list' as a special top-level command
  if (args[0] === 'list') {
    const workflows = discoverWorkflows();
    console.log(JSON.stringify({ workflows }, null, 2));
    return;
  }

  const workflowName = args[0];
  const command = args[1] || 'plan';
  const rest = args.slice(2);

  let workflow;
  try {
    workflow = loadWorkflow(workflowName);
  } catch (err) {
    console.log(JSON.stringify({ error: true, message: err.message }));
    process.exit(1);
  }

  const stateInstance = new WorkflowState(workflow.name, workflow.stateDir);
  const transitionMap = createStatusTransitions(workflow.transitions);
  const allSteps = workflow.steps.map((s) => s.id);

  switch (command) {
    case 'plan': {
      const rawArgs = rest.join(' ').trim();
      if (!rawArgs) {
        console.log(
          JSON.stringify({
            error: true,
            message: `Usage: workflow-engine.js ${workflowName} plan <args>`,
          })
        );
        process.exit(1);
      }

      // Parse args via workflow's params function
      let params;
      try {
        params = workflow.params(rawArgs);
      } catch (err) {
        console.log(JSON.stringify({ error: true, message: `params() error: ${err.message}` }));
        process.exit(1);
      }

      const instanceId = params.instanceId || params.slug || rawArgs;

      // Generate plan
      let plan;
      if (workflow.generatePlan) {
        plan = workflow.generatePlan(instanceId, rawArgs, stateInstance.load(instanceId));
      } else {
        plan = defaultPlanGenerator(workflow, instanceId, rawArgs, stateInstance);
      }

      // Build summary
      const byAction = (a) => plan.filter((s) => s.action === a);
      const summary = {
        total: plan.length,
        run: byAction('RUN').length,
        skip: byAction('SKIP').length,
        defer: byAction('DEFER').length,
        pending: byAction('PENDING').length,
        blocked: byAction('BLOCKED').length,
        // firstAction: BLOCKED takes priority (must resolve before proceeding), then RUN, then DEFER
        firstAction:
          byAction('BLOCKED')[0]?.step ||
          byAction('RUN')[0]?.step ||
          byAction('DEFER')[0]?.step ||
          'none',
        stepsToRun: byAction('RUN').map((s) => s.step),
        stepsDeferred: byAction('DEFER').map((s) => s.step),
        stepsSkipped: byAction('SKIP').map((s) => s.step),
        stepsBlocked: byAction('BLOCKED').map((s) => s.step), // rendered with stop sign icon in formatPlan
      };

      // Format output
      const result = {
        workflow: workflow.name,
        command: workflow.command,
        instanceId,
        params,
        plan,
        summary,
        timestamp: new Date().toISOString(),
        currentStep: stateInstance.getCurrentStep(instanceId),
        allowedTransitions:
          transitionMap[stateInstance.getCurrentStep(instanceId) || allSteps[0]] || [],
      };

      // Add formatted text
      const formatter = workflow.formatPlan || defaultFormatPlan;
      result.formatted = formatter(workflow, instanceId, plan, summary);

      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'transition': {
      if (rest.length < 2) {
        console.log(
          JSON.stringify({
            error: true,
            message: `Usage: workflow-engine.js ${workflowName} transition <instanceId> <step>`,
            validSteps: allSteps,
          })
        );
        process.exit(1);
      }
      const result = transitionStep(workflow, stateInstance, rest[0], rest[1]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'transitions': {
      if (!rest[0]) {
        console.log(
          JSON.stringify({
            error: true,
            message: `Usage: workflow-engine.js ${workflowName} transitions <instanceId>`,
          })
        );
        process.exit(1);
      }
      const result = getAvailableTransitions(workflow, stateInstance, rest[0]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'graph': {
      console.log(
        JSON.stringify(
          {
            workflow: workflow.name,
            steps: allSteps,
            transitions: transitionMap,
          },
          null,
          2
        )
      );
      break;
    }

    default:
      console.log(JSON.stringify({ error: true, message: `Unknown command: ${command}` }));
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  createStatusTransitions,
  canTransition,
  discoverWorkflows,
  loadWorkflow,
  defaultPlanGenerator,
  transitionStep,
  getAvailableTransitions,
  defaultFormatPlan,
};

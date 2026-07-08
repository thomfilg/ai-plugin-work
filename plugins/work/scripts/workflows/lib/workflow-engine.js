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
 * Implementation lives in lib/engine/ (discovery.js, planning.js,
 * transition.js) — this entry wires the CLI and re-exports the public API.
 *
 * Usage:
 *   node workflow-engine.js <workflow-name> plan <args...>
 *   node workflow-engine.js <workflow-name> transition <instanceId> <step>
 *   node workflow-engine.js <workflow-name> transitions <instanceId>
 *   node workflow-engine.js <workflow-name> graph
 *   node workflow-engine.js list
 */

const path = require('path');
const { WorkflowState } = require('./workflow-state');
const { discoverWorkflows, loadWorkflow } = require('./engine/discovery');
const {
  defaultPlanGenerator,
  resolveCompletedState,
  defaultFormatPlan,
  buildPlanSummary,
} = require('./engine/planning');
const {
  createStatusTransitions,
  canTransition,
  transitionStep,
  getAvailableTransitions,
} = require('./engine/transition');

// ─── CLI ─────────────────────────────────────────────────────────────────────

function exitUsage(message, extra) {
  console.log(JSON.stringify({ error: true, message, ...(extra || {}) }));
  process.exit(1);
}

function cmdPlan(ctx, rest) {
  const { workflow, workflowName, stateInstance, transitionMap, allSteps } = ctx;
  const rawArgs = rest.join(' ').trim();
  if (!rawArgs) {
    exitUsage(`Usage: workflow-engine.js ${workflowName} plan <args>`);
  }

  // Parse args via workflow's params function
  let params;
  try {
    params = workflow.params(rawArgs);
  } catch (err) {
    exitUsage(`params() error: ${err.message}`);
  }

  const instanceId = params.instanceId || params.slug || rawArgs;

  // GH-307: SHA-gated release of a completed instance BEFORE planning —
  // re-invoking the workflow after completion starts a fresh cycle when
  // the SHAs drifted, and reports "still valid" when unchanged.
  const completedState = resolveCompletedState(workflow, stateInstance, instanceId);

  // Generate plan
  let plan;
  if (workflow.generatePlan) {
    plan = workflow.generatePlan(instanceId, rawArgs, stateInstance.load(instanceId));
  } else {
    plan = defaultPlanGenerator(workflow, instanceId, rawArgs, stateInstance);
  }

  const summary = buildPlanSummary(plan);

  // Format output
  const result = {
    workflow: workflow.name,
    command: workflow.command,
    instanceId,
    params,
    plan,
    summary,
    ...(completedState ? { completedState } : {}),
    timestamp: new Date().toISOString(),
    currentStep: stateInstance.getCurrentStep(instanceId),
    allowedTransitions:
      transitionMap[stateInstance.getCurrentStep(instanceId) || allSteps[0]] || [],
  };

  // Add formatted text
  const formatter = workflow.formatPlan || defaultFormatPlan;
  result.formatted = formatter(workflow, instanceId, plan, summary);

  console.log(JSON.stringify(result, null, 2));
}

function cmdTransition(ctx, rest) {
  const { workflow, workflowName, stateInstance, allSteps } = ctx;
  if (rest.length < 2) {
    exitUsage(`Usage: workflow-engine.js ${workflowName} transition <instanceId> <step>`, {
      validSteps: allSteps,
    });
  }
  const result = transitionStep(workflow, stateInstance, rest[0], rest[1]);
  console.log(JSON.stringify(result, null, 2));
}

function cmdTransitions(ctx, rest) {
  const { workflow, workflowName, stateInstance } = ctx;
  if (!rest[0]) {
    exitUsage(`Usage: workflow-engine.js ${workflowName} transitions <instanceId>`);
  }
  const result = getAvailableTransitions(workflow, stateInstance, rest[0]);
  console.log(JSON.stringify(result, null, 2));
}

function cmdGraph(ctx) {
  console.log(
    JSON.stringify(
      {
        workflow: ctx.workflow.name,
        steps: ctx.allSteps,
        transitions: ctx.transitionMap,
      },
      null,
      2
    )
  );
}

const COMMANDS = {
  plan: cmdPlan,
  transition: cmdTransition,
  transitions: cmdTransitions,
  graph: cmdGraph,
};

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    exitUsage('Usage: workflow-engine.js <workflow-name> <command> [args...] | list');
  }

  // Handle 'list' as a special top-level command
  if (args[0] === 'list') {
    const workflows = discoverWorkflows();
    console.log(JSON.stringify({ workflows }, null, 2));
    return;
  }

  // GH-531 R2: `reset-follow-up <TICKET>` — wipe `/follow-up` state files and
  // re-initialize a fresh state. Routed through workflow-engine.js so it
  // inherits the existing EXEMPT_SCRIPTS write-rights and does not trip
  // `protect-state-files` (no new exemption entry is added).
  if (args[0] === 'reset-follow-up') {
    const { run } = require(path.join(__dirname, '..', 'follow-up', 'reset-follow-up.js'));
    process.exit(run(args.slice(1)));
  }

  const workflowName = args[0];
  const command = args[1] || 'plan';
  const rest = args.slice(2);

  let workflow;
  try {
    workflow = loadWorkflow(workflowName);
  } catch (err) {
    exitUsage(err.message);
  }

  const ctx = {
    workflow,
    workflowName,
    stateInstance: new WorkflowState(workflow.name, workflow.stateDir),
    transitionMap: createStatusTransitions(workflow.transitions),
    allSteps: workflow.steps.map((s) => s.id),
  };

  const handler = COMMANDS[command];
  if (!handler) {
    exitUsage(`Unknown command: ${command}`);
  }
  handler(ctx, rest);
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
  resolveCompletedState,
  transitionStep,
  getAvailableTransitions,
  defaultFormatPlan,
};

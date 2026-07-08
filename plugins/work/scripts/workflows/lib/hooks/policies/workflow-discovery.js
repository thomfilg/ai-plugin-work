/**
 * policies/workflow-discovery.js
 *
 * Workflow auto-discovery for enforce-step-workflow.js (Open/Closed Principle).
 *
 * Scans workflows/<name>/workflow-definition.js and instantiates each factory
 * with the shared deps. Broken definitions are skipped fail-open (a bad
 * workflow must never block tool use).
 *
 * Also merges the per-workflow agentGatedScripts maps (GH-206 Task 12) so
 * future workflows can register their own gated writer scripts without
 * editing the hook.
 */

const fs = require('fs');
const path = require('path');

// (Patch 11) Transient stderr logging gated behind debug env var
const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG;

// The workflows/ root — two levels up from policies/ (hooks dir's parent's parent).
const WORKFLOWS_DIR = path.join(__dirname, '..', '..', '..');

function loadWorkflowDefinition(defPath, workflowDeps, out) {
  try {
    const factory = require(defPath);
    const { workflow, artifactRules = [] } = factory(workflowDeps);
    out.workflows.push(workflow);
    out.artifactRules.push(...artifactRules);
  } catch (err) {
    if (DEBUG)
      process.stderr.write(`WARNING: Failed to load workflow from ${defPath}: ${err?.message}\n`);
    // fail-open: broken workflow definitions don't block tool use
  }
}

function discoverWorkflows(workflowDeps) {
  const out = { workflows: [], artifactRules: [] };

  try {
    const entries = fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const defPath = path.join(WORKFLOWS_DIR, entry.name, 'workflow-definition.js');
      if (!fs.existsSync(defPath)) continue;
      loadWorkflowDefinition(defPath, workflowDeps, out);
    }
  } catch (err) {
    if (DEBUG) process.stderr.write(`WARNING: Failed to discover workflows: ${err?.message}\n`);
  }

  return out;
}

/**
 * Agent-gated writer scripts — map script basename to { agents, step }.
 * Sourced from workflow-definition.js (declarative policy config) and merged
 * across all discovered workflows.
 */
function mergeAgentGatedScripts(workflows) {
  const merged = {};
  for (const wf of workflows) {
    if (wf && wf.agentGatedScripts && typeof wf.agentGatedScripts === 'object') {
      Object.assign(merged, wf.agentGatedScripts);
    }
  }
  return merged;
}

module.exports = {
  discoverWorkflows, // scan workflows/*/workflow-definition.js
  mergeAgentGatedScripts, // merge per-workflow agentGatedScripts maps
};

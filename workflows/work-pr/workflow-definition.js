/**
 * workflows/work-pr/workflow-definition.js
 *
 * Work-PR workflow definition -- extracted from enforce-step-workflow.js
 * for auto-discovery. Follows Open/Closed Principle: add new workflows
 * by creating workflow-definition.js in their directory.
 */

const path = require('path');

/**
 * @param {Object} _deps - Shared dependencies injected by enforce-step-workflow (unused by work-pr)
 * @returns {{ workflow: Object, artifactRules: Array }}
 */
module.exports = function createWorkflowDefinition(_deps) {
  const workflow = {
    name: 'work-pr',
    stateFile: '.work-pr.workflow-state.json',
    evidenceFile: '.step-evidence-work-pr.json',
    isActive: (state) => state?.status === 'in_progress' && state?.workflow === 'work-pr',
    steps: [
      '1_preflight', '2_setup', '3_pr_gen',
      '4_screenshot_gate', '5_post_pr_gen', '6_summary',
    ],
    softSteps: new Set(['1_preflight', '2_setup', '4_screenshot_gate', '6_summary']),
    commandMap: [
      { step: '3_pr_gen',       tool: 'Task',  field: 'subagent_type', pattern: /^(work-workflow:)?pr-generator$/ },
      { step: '3_pr_gen',       tool: 'Agent', field: 'subagent_type', pattern: /^(work-workflow:)?pr-generator$/ },
      { step: '3_pr_gen',       tool: 'Bash',  field: 'command', pattern: /gh\s+pr\s+create/ },
      { step: '3_pr_gen',       tool: 'Bash',  field: 'command', pattern: /gh\s+pr\s+edit/ },
      { step: '5_post_pr_gen',  tool: 'Task',  field: 'subagent_type', pattern: /^(work-workflow:)?pr-post-generator$/ },
      { step: '5_post_pr_gen',  tool: 'Agent', field: 'subagent_type', pattern: /^(work-workflow:)?pr-post-generator$/ },
    ],
    transitionPattern: /workflow-engine\.js\s+work-pr\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /workflow-engine\.js\s+work-pr\s+(plan|transitions|graph)/,
      /workflow-state\.js\s+work-pr\s+(get|resume-info)/,
    ],
    transitionHint: `node ${path.join(__dirname, '..', 'lib', 'workflow-engine.js')} work-pr transition`,
  };

  return { workflow, artifactRules: [] };
};

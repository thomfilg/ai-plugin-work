/**
 * Step: reports
 *
 * Emits a `cost-report.md` into the task's tasks directory (GH-311 R3): loads
 * `kind:'usage'` rows from `.work-actions.json`, derives per-step durations from
 * `analyzeActions()`, renders the markdown via `cost-report.js`, and queues an
 * authorized `reports`-step write of the rendered report. Degrades gracefully —
 * a ticket with no usage rows still produces a valid (zero-row) report.
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
const { loadActions, analyzeActions, USAGE_KIND } = require('../lib/work-actions');
const { renderCostReport } = require('../lib/cost-report');
const { WORK_PRICING } = require('../../lib/config');

module.exports = function reportsStep(add, s, ctx) {
  const { STEPS, tasksDir, ticket } = ctx;

  const markdown = buildCostReport(ticket);
  const reportPath = `${tasksDir}/cost-report.md`;

  add(STEPS.reports, 'RUN', 'Task(Bash)', 'Emit cost-report.md', {
    agentType: 'Bash',
    agentPrompt: writeFileCommand(reportPath, markdown),
  });
};

/**
 * Load usage rows + per-step durations for `ticket` and render the cost report
 * markdown. Tolerates a missing/empty actions file (zero-row report).
 *
 * @param {string} ticket
 * @returns {string} Rendered `cost-report.md` markdown.
 */
function buildCostReport(ticket) {
  const actions = loadActions(ticket) || [];
  const usageRecords = actions.filter((a) => a && a.kind === USAGE_KIND);
  const stepDurations = stepDurationMap(analyzeActions(actions));
  // GH-311 fix: read the parsed pricing table from config.js (its IIFE
  // JSON-parses the WORK_PRICING env override and falls back to the default
  // table). Using get-config's raw `process.env[key]` here returned the JSON
  // string when WORK_PRICING was set as an env var, so Object.keys() yielded
  // character indices and every cost report showed $0.00.
  const pricingTable = WORK_PRICING || {};
  const model = Object.keys(pricingTable)[0];

  return renderCostReport({ ticket, usageRecords, stepDurations, model, pricingTable });
}

/**
 * Reduce `analyzeActions().steps` (`[{ step, duration }]`) into the
 * `{ step → durationString }` map `renderCostReport` consumes for its per-step
 * Duration column (GH-311 R5).
 *
 * @param {{ steps?: Array<{step: string, duration: string}> }} analysis
 * @returns {Object<string, string>}
 */
function stepDurationMap(analysis) {
  const map = {};
  for (const entry of (analysis && analysis.steps) || []) {
    map[entry.step] = entry.duration;
  }
  return map;
}

/**
 * Build a Bash command that writes `content` verbatim to `filePath` via a
 * quoted heredoc (no interpolation), so the authorized `reports`-step agent can
 * materialize the rendered report.
 *
 * @param {string} filePath
 * @param {string} content
 * @returns {string}
 */
function writeFileCommand(filePath, content) {
  return `cat > "${filePath}" <<'COST_REPORT_EOF'\n${content}\nCOST_REPORT_EOF`;
}

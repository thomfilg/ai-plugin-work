/**
 * Step: reports
 *
 * Two outputs, one step:
 *
 *  - `cost-report.md` (GH-311 R3) — loads `kind:'usage'` rows from
 *    `.work-actions.json`, derives per-step durations from `analyzeActions()`,
 *    and renders the markdown via `cost-report.js`. Degrades gracefully: a
 *    ticket with no usage rows still produces a valid (zero-row) report.
 *  - `reports.md` — the cross-step summary the `reports-writer` agent writes
 *    through the self-paced `reports-next.js` runner
 *    (inputs -> collect_artifacts -> summarize -> emit -> memorize -> done).
 *
 * The runner used to be unreachable: this step dispatched only the cost-report
 * Bash write, so `reports-writer` was never invoked and the whole work-reports
 * workflow — the summary, its shape gate, and the ticket-level memorize —
 * never ran. The step "completed" the moment a heredoc finished, which is what
 * made it look like it auto-advanced. Dispatching the agent (with the runner
 * as its driver, mirroring steps/pr.js) is what makes the step do its job.
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
const { loadActions, analyzeActions, USAGE_KIND } = require('../lib/work-actions');
const { renderCostReport } = require('../lib/cost-report');
const { WORK_PRICING } = require('../../lib/config');

module.exports = function reportsStep(add, s, ctx) {
  const { STEPS, tasksDir, ticket, t } = ctx;
  const id = ticket || t;

  const markdown = buildCostReport(ticket, t);
  const reportPath = `${tasksDir}/cost-report.md`;

  add(STEPS.reports, 'RUN', 'Task(reports-writer)', 'Emit reports.md + cost-report.md', {
    agentType: 'reports-writer',
    agentPrompt: reportsPrompt(id, reportPath, markdown),
  });
};

/**
 * The reports-writer's brief: emit the cost report verbatim (it is rendered
 * here, from data the agent cannot see), then drive the summary runner.
 */
function reportsPrompt(id, reportPath, markdown) {
  return [
    `Produce the delivery reports for ${id}.`,
    '',
    '1. Write the pre-rendered cost report exactly as given:',
    '',
    writeFileCommand(reportPath, markdown),
    '',
    '2. Then write `reports.md` (and `learnings.md`) through the self-paced runner —',
    '   run it before and after each sub-action, and do NOT edit `reports-phase.json`:',
    '',
    `   node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-reports/reports-next.js ${id}`,
  ].join('\n');
}

/**
 * Load usage rows + per-step durations for `ticket` and render the cost report
 * markdown. Tolerates a missing/empty actions file (zero-row report).
 *
 * Description mode passes `ticket = null` (no ticket exists until the plan's
 * ticket step runs) — `loadActions(null)` would throw on the path join, so a
 * null ticket skips the load and renders a zero-row report labelled with the
 * `displayName` placeholder (ctx.t, e.g. `{TICKET}`).
 *
 * @param {string|null} ticket
 * @param {string} [displayName] — fallback report label when `ticket` is null.
 * @returns {string} Rendered `cost-report.md` markdown.
 */
function buildCostReport(ticket, displayName) {
  const actions = (ticket ? loadActions(ticket) : []) || [];
  const usageRecords = actions.filter((a) => a && a.kind === USAGE_KIND);
  const stepDurations = stepDurationMap(analyzeActions(actions));
  // GH-311 fix: read the parsed pricing table from config.js (its IIFE
  // JSON-parses the WORK_PRICING env override and falls back to the default
  // table). Using get-config's raw `process.env[key]` here returned the JSON
  // string when WORK_PRICING was set as an env var, so Object.keys() yielded
  // character indices and every cost report showed $0.00.
  const pricingTable = WORK_PRICING || {};
  const model = Object.keys(pricingTable)[0];

  return renderCostReport({
    ticket: ticket || displayName || '{TICKET}',
    usageRecords,
    stepDurations,
    model,
    pricingTable,
  });
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

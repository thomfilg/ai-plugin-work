'use strict';
/**
 * render-line.js — compose the /work status bar line from a parsed work state.
 *
 * Pure (no stdin, no fs, no shell) so the layout and the follow-up hand-off are
 * unit-testable. The stdin/marker plumbing lives in work-statusline.js.
 *
 * Follow-up hand-off: while the run is on the `follow_up` step this returns ''
 * so the chained follow-up bar (🔄) is the only line shown. When the run
 * advances to `ci`, follow_up is no longer in_progress and the work bar returns.
 */

const {
  currentStepName,
  stepPosition,
  stepElapsedMs,
  formatElapsedMs,
  colorizeElapsed,
} = require('./step-meta');
const { detailFor } = require('./step-detail');

const SEP = '   ·   ';

/**
 * True while the follow-up sub-workflow owns the bar — the work bar yields.
 * @param {object} state parsed `.work-state.json`
 * @returns {boolean}
 */
function isFollowUpActive(state) {
  const stepStatus = (state && state.stepStatus) || {};
  return stepStatus.follow_up === 'in_progress';
}

/**
 * The composed status line for a ticket, or '' when nothing should show
 * (no state, or the follow-up bar has taken over).
 * @param {string} ticket ticket dir name / id
 * @param {object} state parsed `.work-state.json`
 * @param {number} now epoch ms (injectable for tests)
 * @returns {string}
 */
function buildLine(ticket, state, now = Date.now()) {
  if (!state || isFollowUpActive(state)) return '';
  const step = currentStepName(state);
  const { completed, total } = stepPosition(state);
  const bits = [`⚙ ${ticket}`, `▶ ${step} (${completed}/${total})`];

  const detail = detailFor(step, state);
  if (detail) bits.push(detail);

  const elapsedMs = stepElapsedMs(state, now);
  const elapsedText = formatElapsedMs(elapsedMs);
  if (elapsedText) bits.push(colorizeElapsed(step, elapsedMs, elapsedText));

  return bits.join(SEP);
}

module.exports = { buildLine, isFollowUpActive, SEP };

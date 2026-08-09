'use strict';

/**
 * report.js — how a refusal reads.
 *
 * Split from the decision so the rules and their presentation can change
 * independently, and so every enforcement point renders the same block
 * whatever found the problem: the hook, the CLI, and the git hooks all show an
 * operator the same four lines and the same fix.
 *
 * The block quotes the offending line rather than describing it. A guard that
 * says "attribution found" sends someone hunting; one that prints the line
 * they wrote ends the question.
 */

const { OVERRIDE_ENV } = require('./policy');

/**
 * The headline, per rule. Most findings are a tool signing itself, but two are
 * not: an absent author signs nothing, and an unverifiable account is a
 * question the guard could not answer. Reporting either as self-attribution
 * sends the operator looking for a footer that was never there.
 */
const HEADLINES = {
  missingIdentity: 'would author a commit that names nobody',
  unverifiableAccount: 'cannot be shown to be the work of a person',
  unverifiableIdentity: 'cannot be shown to be the work of a person',
  unverifiableMessage: 'carries text the guard could not read in full',
  unverifiableCommand: 'carries text the guard could not read in full',
};
const DEFAULT_HEADLINE = 'would sign the work as an AI';

/**
 * Render a finding as the stderr block the runtime shows the agent.
 *
 * @param {object} hit
 * @param {string} [subject] - what is being refused, for the headline.
 */
function renderBlock(hit, subject) {
  const lines = [
    `ghostwriter: ${subject || 'this command'} ${HEADLINES[hit.rule] || DEFAULT_HEADLINE}.`,
    '',
    `  rule      ${hit.rule}`,
    `  where     ${hit.where}`,
    `  problem   ${hit.reason}`,
    `  evidence  ${hit.evidence}`,
    '',
    `↳ Fix: ${hit.hint}`,
    '',
    'The change belongs to the person who asked for it. Tools do not get a byline.',
  ];
  if (hit.selfGranted) {
    lines.push(
      '',
      `Note: ${OVERRIDE_ENV} set inside the command is ignored — the override is`,
      "honoured only from the operator's own environment."
    );
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { renderBlock, HEADLINES };

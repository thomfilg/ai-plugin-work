/**
 * Phase: env_setup — confirm the dev environment is ready for QA.
 *
 * Gate is on a sentinel `.qa-env-ready` written by the agent after they:
 *  - confirmed the dev server is reachable (curl / browser nav)
 *  - confirmed test data is seeded (if applicable)
 *  - opened a browser tab via claude-in-chrome / playwright
 *
 * The agent writes the sentinel themselves — we don't try to detect a
 * running server from inside this script.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QA_PHASES } = require('../../qa-phase-registry');

const SENTINEL = '.qa-env-ready';

function validate(ctx) {
  const p = path.join(ctx.tasksDir, SENTINEL);
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Missing \`${SENTINEL}\`. Start the dev server, open the feature in a browser, seed test data if needed, then \`touch ${p}\`.`,
      ],
    };
  }
  return { ok: true, summary: 'environment confirmed ready' };
}

function instructions(ctx) {
  return [
    '# qa-next — Phase 2 of 9: ENV SETUP',
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    '1. Start the dev server in a tmux session (per the global tmux rules — use the branch name).',
    '2. Confirm the URL responds (curl or browser).',
    '3. If the feature needs test data, seed it now.',
    '4. Open the feature in claude-in-chrome (or Playwright) and confirm the page loads.',
    `5. \`touch ${path.join(ctx.tasksDir, SENTINEL)}\` to advance.`,
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.env_setup, {
    next: QA_PHASES.smoke,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.SENTINEL = SENTINEL;

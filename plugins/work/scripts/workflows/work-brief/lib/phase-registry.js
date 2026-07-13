/**
 * Brief phase dispatcher.
 *
 * The orchestrator (brief-next.js) has NO phase-specific logic — it looks up
 * the current phase here, calls validate, advances on ok, and prints
 * instructions from the (possibly new) phase. Add a phase by creating
 * `phases/<name>.js` and `require`-ing it below.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('brief');

// ─── Register all phases ────────────────────────────────────────────────────
require('./phases/inputs')(registerPhase);
require('./phases/overlap')(registerPhase);
require('./phases/draft')(registerPhase);
require('./phases/validate')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

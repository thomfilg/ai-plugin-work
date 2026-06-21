/**
 * Spec phase dispatcher.
 *
 * The orchestrator (spec-next.js) has NO phase-specific logic — it looks up
 * the current phase here, calls validate, advances on ok, and prints
 * instructions from the (possibly new) phase.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('spec');

require('./phases/inputs')(registerPhase);
require('./phases/reuse_audit')(registerPhase);
require('./phases/surface_audit')(registerPhase);
require('./phases/draft')(registerPhase);
require('./phases/validate')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

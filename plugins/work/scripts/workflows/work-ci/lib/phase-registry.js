/**
 * CI phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('ci');

require('./phases/inputs')(registerPhase);
require('./phases/wait')(registerPhase);
require('./phases/triage')(registerPhase);
require('./phases/fix_or_document')(registerPhase);
require('./phases/rerun_check')(registerPhase);
require('./phases/wait_merge')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

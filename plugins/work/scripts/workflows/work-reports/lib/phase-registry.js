/**
 * Reports phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('reports');

require('./phases/inputs')(registerPhase);
require('./phases/collect_artifacts')(registerPhase);
require('./phases/summarize')(registerPhase);
require('./phases/emit')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

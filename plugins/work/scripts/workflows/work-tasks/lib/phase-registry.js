/**
 * Tasks phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('tasks');

require('./phases/inputs')(registerPhase);
require('./phases/requirements_extract')(registerPhase);
require('./phases/draft')(registerPhase);
require('./phases/traceability')(registerPhase);
require('./phases/kind_assign')(registerPhase);
require('./phases/scope_exists')(registerPhase);
require('./phases/gherkin_link')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

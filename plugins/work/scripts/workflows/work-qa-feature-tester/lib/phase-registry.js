/**
 * QA-feature-tester phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('qa');

require('./phases/inputs')(registerPhase);
require('./phases/env_setup')(registerPhase);
require('./phases/smoke')(registerPhase);
require('./phases/feature')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/screenshot')(registerPhase);
require('./phases/report')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

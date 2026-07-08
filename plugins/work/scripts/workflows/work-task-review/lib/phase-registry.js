/**
 * Task-review phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('task-review');

require('./phases/inputs')(registerPhase);
require('./phases/diff_audit')(registerPhase);
require('./phases/reuse_check')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/coverage')(registerPhase);
require('./phases/report')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

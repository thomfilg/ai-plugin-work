/**
 * Cleanup phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('cleanup');

require('./phases/inputs')(registerPhase);
require('./phases/pr_merged_check')(registerPhase);
require('./phases/branch_cleanup')(registerPhase);
require('./phases/tmux_cleanup')(registerPhase);
require('./phases/state_archive')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

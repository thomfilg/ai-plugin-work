/**
 * Code-checker phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('code');

require('./phases/inputs')(registerPhase);
require('./phases/change_classify')(registerPhase);
require('./phases/file_coverage')(registerPhase);
require('./phases/standards_audit')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/report')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

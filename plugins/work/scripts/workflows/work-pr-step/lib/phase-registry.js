/**
 * PR-step phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('pr-step');

require('./phases/inputs')(registerPhase);
require('./phases/diff_audit')(registerPhase);
require('./phases/description_draft')(registerPhase);
require('./phases/validate_description')(registerPhase);
require('./phases/create_or_update')(registerPhase);
require('./phases/attachments')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

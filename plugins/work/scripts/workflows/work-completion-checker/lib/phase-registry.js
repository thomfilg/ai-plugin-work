/**
 * Completion-checker phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('completion');

require('./phases/inputs')(registerPhase);
require('./phases/requirements_extract')(registerPhase);
require('./phases/diff_scope')(registerPhase);
require('./phases/coverage_check')(registerPhase);
require('./phases/reuse_audit_enforcement')(registerPhase);
require('./phases/suggested_scope_enforcement')(registerPhase);
require('./phases/test_pass_crossref')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/report')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

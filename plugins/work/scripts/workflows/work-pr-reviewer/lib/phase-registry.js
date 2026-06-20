/**
 * PR-reviewer phase dispatcher.
 */

'use strict';

const { makePhaseRegistry } = require('../../lib/make-phase-registry');

const { registerPhase, getPhase, hasPhase } = makePhaseRegistry('pr-review');

require('./phases/inputs')(registerPhase);
require('./phases/pr_context')(registerPhase);
require('./phases/diff_audit')(registerPhase);
require('./phases/standards_audit')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/review_post')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };

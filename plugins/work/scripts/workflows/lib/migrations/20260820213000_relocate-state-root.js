'use strict';

/**
 * Move work-workflow's per-user state out of the agent CLI config dir.
 *
 *   ~/.claude/work-workflow/  →  ~/.workflow/work-workflow/
 *
 * That directory holds the once-per-session reminder ledger, the self-paced
 * runner logs, and the inbox cursors. The cursors are the one that bites: they
 * record how many monitor messages have already been delivered per ticket, so
 * losing them re-injects every old message into a fresh session.
 */

const path = require('node:path');
const { relocateStore } = require(path.join(__dirname, '..', 'storeMigration'));

module.exports = {
  description: 'move per-user state out of the agent CLI config dir into .workflow/',
  migrate: relocateStore(),
};

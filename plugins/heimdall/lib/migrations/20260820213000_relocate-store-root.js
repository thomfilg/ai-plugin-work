'use strict';

/**
 * Move the lock store — and the conceal config beside it — out of the agent
 * CLI config dir into `.workflow/`.
 *
 * v3.85.8 relocated every plugin store from `.claude/<folder>` to
 * `.workflow/<folder>`. For heimdall that covers two things:
 *
 *   `.claude/heimdall/`               → `.workflow/heimdall/`   (locks)
 *   `.claude/heimdall-conceal.json`   → `.workflow/heimdall-conceal.json`
 *   `.claude/heimdall-conceal.log`    → `.workflow/heimdall-conceal.log`
 *
 * The conceal config is the security-critical half. The guard is
 * safe-by-default-OFF: with no config it is a silent no-op. So an install left
 * at the old path does not fail loudly — it just stops concealing, and the
 * agent can read the secrets the user believed were blocked. That is why the
 * config is declared in `legacyPaths` (which makes the location live even when
 * no lock store exists) rather than relying on the store move alone.
 */

const path = require('node:path');
const { relocateStore } = require(path.join(__dirname, '..', 'storeMigration'));

module.exports = {
  description: 'move the lock store and conceal config out of the CLI config dir',
  migrate: relocateStore(),
};

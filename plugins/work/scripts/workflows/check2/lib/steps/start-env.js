/**
 * Step: 2_start_env — Run check-start-env.js inline (deterministic).
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerStartEnv(register) {
  register('2_start_env', (state, ctx) => {
    const apps = state.setupResult?.impactedApps || [];
    try {
      execFileSync(
        process.execPath,
        [path.join(ctx.checkHooksDir, 'check-start-env.js'), JSON.stringify(apps)],
        { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch {
      /* fail-open — no apps to start for CLI projects */
    }
    return null; // auto-advance
  });
};

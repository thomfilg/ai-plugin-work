/**
 * Step: 3_verify_playwright — Skip if no web apps (deterministic).
 */

'use strict';

const path = require('path');
// dotenv-aware WEB_APPS resolution — a raw process.env read misses values
// sourced from the worktree's .env (GH-280 review finding).
const config = require(path.join(__dirname, '..', '..', '..', 'lib', 'config'));

module.exports = function registerVerifyPlaywright(register) {
  register('3_verify_playwright', (state) => {
    // Skip if no web apps configured
    const apps = state.setupResult?.impactedApps || [];
    const hasWebApps = apps.length > 0 && config.webAppNames().length > 0;
    if (!hasWebApps) return null; // auto-advance

    // TODO: verify playwright connection for web apps
    return null;
  });
};

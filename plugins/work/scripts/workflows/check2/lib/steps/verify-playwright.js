/**
 * Step: 3_verify_playwright — Skip if no web apps (deterministic).
 */

'use strict';

const { hasWebApps } = require('../../../check/lib/has-web-apps');

module.exports = function registerVerifyPlaywright(register) {
  register('3_verify_playwright', (state) => {
    // Skip if no web apps configured
    const apps = state.setupResult?.impactedApps || [];
    if (!hasWebApps(apps, process.env)) return null; // auto-advance

    // TODO: verify playwright connection for web apps
    return null;
  });
};

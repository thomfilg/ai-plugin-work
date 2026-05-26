/**
 * Step: 3_verify_playwright — Skip if no web apps (deterministic).
 */

'use strict';

module.exports = function registerVerifyPlaywright(register) {
  register('3_verify_playwright', (state) => {
    // Skip if no web apps configured
    const apps = state.setupResult?.impactedApps || [];
    const hasWebApps = apps.length > 0 && process.env.WEB_APPS;
    if (!hasWebApps) return null; // auto-advance

    // TODO: verify playwright connection for web apps
    return null;
  });
};

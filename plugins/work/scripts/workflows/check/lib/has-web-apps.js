'use strict';

/** Single source of truth: true only when impactedApps is non-empty AND env.WEB_APPS is set. */
function hasWebApps(impactedApps, env) {
  return (impactedApps?.length ?? 0) > 0 && Boolean(env?.WEB_APPS);
}

module.exports = { hasWebApps };

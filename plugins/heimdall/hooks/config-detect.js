#!/usr/bin/env node
// Fail-open SessionStart config nudge for heimdall. Two-leg require: the
// vendored runtime lib first (cache installs on either runtime have no
// factories/), the full factories/envConfig as the dev-tree fallback.
try {
  let sessionHook;
  try {
    sessionHook = require('../lib/runtime/envconfig-lite');
  } catch {
    sessionHook = require('../../../factories/envConfig/sessionHook');
  }
  sessionHook.tryMain(__dirname, '/heimdall:configure');
} catch {
  process.exit(0);
}

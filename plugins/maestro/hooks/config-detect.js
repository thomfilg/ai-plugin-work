#!/usr/bin/env node
// Fail-open SessionStart config nudge for maestro — two-leg require: the
// vendored runtime lib first (works in cache-isolated installs on both
// runtimes), full factories/envConfig as the dev-tree fallback.
try {
  require('../scripts/lib/runtime/envconfig-lite').tryMain(__dirname, '/maestro:configure');
} catch {
  try {
    require('../../../factories/envConfig/sessionHook').tryMain(__dirname, '/maestro:configure');
  } catch {
    process.exit(0);
  }
}

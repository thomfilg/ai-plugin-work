#!/usr/bin/env node
// Fail-open SessionStart config nudge for synapsys — two-leg require: the
// vendored runtime lib first (works in cache-isolated installs on both
// runtimes), full factories/envConfig as the dev-tree fallback.
try {
  require('../lib/runtime/envconfig-lite').tryMain(__dirname, '/synapsys:configure');
} catch {
  try {
    require('../../../factories/envConfig/sessionHook').tryMain(__dirname, '/synapsys:configure');
  } catch {
    process.exit(0);
  }
}

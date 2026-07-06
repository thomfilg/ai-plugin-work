#!/usr/bin/env node
// Fail-open SessionStart config nudge for heimdall — logic in factories/envConfig.
try {
  require('../../../factories/envConfig/sessionHook').tryMain(__dirname, '/heimdall:configure');
} catch {
  process.exit(0);
}

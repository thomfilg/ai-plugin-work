#!/usr/bin/env node
// Fail-open SessionStart config nudge for maestro — logic in factories/envConfig.
try {
  require('../../../factories/envConfig/sessionHook').tryMain(__dirname, '/maestro:configure');
} catch {
  process.exit(0);
}

#!/usr/bin/env node
// Fail-open SessionStart config nudge for synapsys — logic in factories/envConfig.
try {
  require('../../../factories/envConfig/sessionHook').tryMain(__dirname, '/synapsys:configure');
} catch {
  process.exit(0);
}

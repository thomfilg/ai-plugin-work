#!/usr/bin/env node
// Fail-open SessionStart config nudge for work — logic in factories/envConfig.
try {
  require('../../../factories/envConfig/sessionHook').tryMain(
    __dirname,
    '/work-workflow:configure'
  );
} catch {
  process.exit(0);
}

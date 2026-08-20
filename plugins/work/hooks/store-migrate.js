#!/usr/bin/env node
'use strict';

/**
 * SessionStart: bring work-workflow's per-user state forward before anything
 * reads it. Registered first so the reminder ledger and inbox cursors are in
 * place before the hooks that consult them.
 *
 * Fail-open by construction: `runMigrations` never throws and never writes to
 * stderr, and state it could not migrate is simply left where it was.
 */

const path = require('node:path');
const { runHook } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'lib', 'hookEntrypoint')
);
const { runMigrations } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'lib', 'store-migrations')
);

runHook((payload) => {
  runMigrations((payload && payload.cwd) || process.cwd());
});

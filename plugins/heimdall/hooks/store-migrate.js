#!/usr/bin/env node
'use strict';

/**
 * SessionStart: bring heimdall's stores forward before anything reads them.
 *
 * Registered FIRST in the SessionStart list on purpose. The sibling hooks read
 * the conceal config, and the guard is safe-by-default-OFF — a config still
 * sitting at the pre-`.workflow` path reads as "no config", so the session
 * would run with concealment silently disabled.
 *
 * Fail-open by construction: `runMigrations` never throws and never writes to
 * stderr, and a store it could not migrate is simply left where it was.
 */

const path = require('node:path');
const { runHook } = require(path.join(__dirname, '..', 'lib', 'hookEntrypoint'));
const { runMigrations } = require(path.join(__dirname, '..', 'lib', 'store-migrations'));

runHook((payload) => {
  runMigrations((payload && payload.cwd) || process.cwd());
});

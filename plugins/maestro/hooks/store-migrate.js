#!/usr/bin/env node
'use strict';

/**
 * SessionStart: bring maestro's schema stores forward before anything reads
 * them. Fail-open by construction — `runMigrations` never throws and never
 * writes to stderr, and a store it could not migrate is left where it was.
 */

const path = require('node:path');
const { runMigrations } = require(path.join(__dirname, '..', 'lib', 'store-migrations'));

try {
  let raw = '';
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    /* no stdin */
  }
  let payload = {};
  try {
    payload = JSON.parse(raw) || {};
  } catch {
    /* malformed payload → cwd fallback */
  }
  runMigrations(payload.cwd || process.cwd());
} catch {
  /* fail-open */
}
process.exit(0);

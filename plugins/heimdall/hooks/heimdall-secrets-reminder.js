#!/usr/bin/env node
/*
 * heimdall-secrets-reminder.js — SessionStart nag.
 *
 * If THIS project (or an ancestor) declares a secret for protection in
 * heimdall-conceal.json but the OS boundary is NOT actually installed (the agent
 * can still read it / the broker is missing / a rootful-docker bypass is open),
 * inject a blunt reminder at session start. It repeats every session until the
 * privileged install is done — so "I ran /heimdall:install but skipped the sudo
 * step" can never quietly look protected.
 *
 * Decision is delegated to heimdall-conceal-status.js (single source of truth):
 *   exit 2 -> NOT PROTECTED -> remind.   exit 0 -> protected/absent -> silent.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function projectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input && typeof input.cwd === 'string') return input.cwd;
  } catch {
    /* no/!json stdin — fall through to cwd */
  }
  return process.cwd();
}

function main() {
  const dir = projectDir();
  const status = path.join(__dirname, '..', 'scripts', 'heimdall-conceal-status.js');
  // The status script owns the verdict AND the case-specific message (install
  // not run vs. installed-but-docker-bypassable) via --reminder. Single source
  // of truth: the hook just forwards its text. Args passed as argv (no shell).
  const r = spawnSync(process.execPath, [status, dir, '--reminder'], { encoding: 'utf8' });
  if (r.status !== 2 || !r.stdout || !r.stdout.trim()) return; // protected / no config / nothing to say

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r.stdout.trim() },
    })
  );
}

main();

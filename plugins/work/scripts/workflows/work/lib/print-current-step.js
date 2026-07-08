#!/usr/bin/env node
/**
 * print-current-step.js
 *
 * Prints the name of the active /work step (e.g. `implement`, `follow_up`,
 * `ci`) for the most-recently-modified ticket under TASKS_BASE.
 *
 * Intended for use from a Claude Code statusline wrapper — see
 * docs/statusline-integration.md.
 *
 * Contract:
 *   - On success: writes the step name to stdout (no trailing newline) and
 *     exits 0.
 *   - On any error or "no active ticket" condition: prints nothing and
 *     exits 0. The statusline must never break, so every failure mode is
 *     swallowed.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

try {
  // Resolve get-config relative to this file. We deliberately avoid
  // resolve-plugin-root here because that helper requires the plugin's
  // `workflows/` symlink layout, which may not exist in arbitrary callers'
  // working directories. Going up two levels from work/lib/ lands at
  // scripts/workflows, where the shared `lib/` sits next to `work/`.
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  const { ALL_STEPS } = require(path.join(__dirname, '..', 'step-registry'));

  const TASKS_BASE = getConfig('TASKS_BASE');
  if (!TASKS_BASE || !fs.existsSync(TASKS_BASE)) process.exit(0);

  // Find the most-recently-modified .work-state.json across all tickets.
  let newest = null;
  for (const ent of fs.readdirSync(TASKS_BASE, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const statePath = path.join(TASKS_BASE, ent.name, '.work-state.json');
    try {
      const stat = fs.statSync(statePath);
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { state: statePath, mtimeMs: stat.mtimeMs };
      }
    } catch {
      /* no state file in this ticket dir */
    }
  }
  if (!newest) process.exit(0);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(newest.state, 'utf8'));
  } catch {
    // Malformed state file — fail silent.
    process.exit(0);
  }

  // currentStep in .work-state.json is 1-indexed (see e.g. ci-gate.js
  // setting `ws.currentStep = ALL_STEPS.indexOf('cleanup') + 1`).
  // Fail-silent contract: if currentStep is missing / not a positive
  // integer, print nothing rather than defaulting to step 1 ("ticket"),
  // which would be a misleading indicator.
  const raw = data && data.currentStep;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 1) process.exit(0);
  const idx = num - 1;
  const stepName = (idx >= 0 && idx < ALL_STEPS.length) ? ALL_STEPS[idx] : '';
  if (stepName) process.stdout.write(stepName);
} catch {
  // Any unexpected error → fail silent, statusline must never break.
  process.exit(0);
}

/**
 * gate-input-hashes.js — GH-419
 *
 * Content-hashing of gate input artifacts for the gateFingerprints audit
 * trail. WRITE-ONLY audit data: the orchestrator never reads or enforces on
 * these hashes (no per-gate short-circuit — see GH-419 "What this is NOT").
 * The compare helper exists for future tooling (drift diagnostics,
 * isGateAlreadySatisfied-style consumers) and tests.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Fixed map of gate step → input artifact files (relative to the ticket tasks dir). */
const GATE_INPUT_FILES = {
  spec_gate: ['spec.md', 'gherkin.feature'],
  tasks_gate: ['tasks.md', 'gherkin.feature'],
};

/**
 * sha256 each mapped input file of a gate. Missing/unreadable files hash as
 * null — never throws. Gates without a mapping return an empty object.
 *
 * @param {string} gate - gate step name (e.g. 'spec_gate')
 * @param {string} tasksDir - ticket tasks directory (TASKS_BASE/<safeTicket>)
 * @returns {Record<string, string|null>} filename → sha256 hex (or null when absent)
 */
function computeGateInputHashes(gate, tasksDir) {
  const inputs = {};
  for (const file of GATE_INPUT_FILES[gate] || []) {
    try {
      const content = fs.readFileSync(path.join(tasksDir, file));
      inputs[file] = crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      inputs[file] = null; // absent/unreadable: record explicitly, fail-open
    }
  }
  return inputs;
}

/**
 * Compare a recorded inputs map against a freshly computed one. A legacy
 * fingerprint without inputs (undefined/null recorded) never matches — every
 * current file is reported as drifted. Never throws.
 *
 * @param {Record<string, string|null>|undefined} recorded
 * @param {Record<string, string|null>|undefined} current
 * @returns {{ match: boolean, drifted: string[] }} drifted is sorted by filename
 */
function compareGateInputHashes(recorded, current) {
  const rec = recorded || {};
  const cur = current || {};
  const files = new Set([...Object.keys(rec), ...Object.keys(cur)]);
  const drifted = [...files].filter((f) => rec[f] !== cur[f]).sort();
  return { match: drifted.length === 0, drifted };
}

module.exports = { GATE_INPUT_FILES, computeGateInputHashes, compareGateInputHashes };

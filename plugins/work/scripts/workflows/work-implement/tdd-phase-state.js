#!/usr/bin/env node

/**
 * tdd-phase-state.js
 *
 * CLI script for managing TDD phase state.
 * This is the ONLY way evidence gets recorded — agents never self-report.
 *
 * Scope boundary (GH-212):
 *   REFACTOR evidence recorded here is developer self-cleanup only. The
 *   external review gate (/tests-review + /code-review) is NOT part of
 *   REFACTOR and is NOT invoked by this CLI. The post-commit review gate
 *   lives in workflows/work/steps/task-review.js (GH-211) and runs after
 *   the commit step, against the committed diff. Keeping reviews out of
 *   the TDD phase state machine means the normal TDD loop preserves the
 *   clean RED / GREEN / REFACTOR flow, while exception handling remains
 *   an out-of-band state, and ensures reviewers never see
 *   half-refactored work.
 *
 * Usage:
 *   node tdd-phase-state.js init <TICKET_ID>
 *   node tdd-phase-state.js current <TICKET_ID>
 *   node tdd-phase-state.js record-red <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js record-green <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js record-refactor <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js transition <TICKET_ID> <target_phase>
 *   node tdd-phase-state.js exception <TICKET_ID> --category <category> --reason "<reason>"
 *
 * Implementation note (GH-610 static-quality refactor): the helpers and
 * subcommands live under `tdd-phase-state/` to keep each module within the
 * static-quality budget. This file stays the entrypoint so the write-token
 * lookup remains keyed to `tdd-phase-state.js` (verifyToken receives the
 * basename of __filename) and so tests that spawn this path are unchanged.
 */

const path = require('path');
const { errorExit } = require('./tdd-phase-state/io');
const { verifyToken } = require('./tdd-phase-state/token');
const {
  cmdInit,
  cmdCurrent,
  cmdRecordGreen,
  cmdRecordRefactor,
  cmdTransition,
} = require('./tdd-phase-state/record-cycle');
const { cmdRecordRed, cmdRecordSkipRed } = require('./tdd-phase-state/record-red');
const { cmdException } = require('./tdd-phase-state/exception');

// Subcommands that require token verification
const GATED_SUBCOMMANDS = [
  'record-red',
  'record-skip-red',
  'record-green',
  'record-refactor',
  'transition',
  'exception',
];

// ─── Main ───────────────────────────────────────────────────────────────────

// CLI dispatch only when invoked with subcommand arguments. When `node --test`
// loads this file (e.g. CHANGED_FILES sweeps that include the source alongside
// tests), argv has no subcommand — skip dispatch so the runner just records the
// file with zero tests instead of hitting the subcommand switch + errorExit.
// Using process.exit(0) instead of top-level `return` because the standalone
// biome parser (used by the pre-commit format gate) rejects top-level return.
//
// GH-528 round-2 follow-up (Cursor[bot] low): distinguish "loaded by another
// module / node --test runner" (require.main !== module) from "operator
// invoked the bare CLI" (require.main === module && argv has no subcommand).
// The former must stay silent; the latter must error so operators / wrappers
// don't misread a no-op invocation as success.
if (process.argv.length < 3) {
  if (require.main === module) {
    errorExit(
      'Missing subcommand. Usage: tdd-phase-state.js <subcommand> <TICKET_ID> [...]. ' +
        'Valid subcommands: init, current, record-red, record-skip-red, record-green, record-refactor, transition, exception.'
    );
  }
  process.exit(0);
}

const args = process.argv.slice(2);
const subcommand = args[0];
const ticketId = args[1];

// Token gating: enforce-step-workflow.js Rule 5 issues tokens via AGENT_GATED_SCRIPTS
// where tdd-phase-state.js is registered with developer-* agents authorized.
// WORK_TDD_TOKEN_SKIP=1 bypasses verification for standalone/debugging use.
if (GATED_SUBCOMMANDS.includes(subcommand) && process.env.WORK_TDD_TOKEN_SKIP !== '1') {
  verifyToken(ticketId, path.basename(__filename));
}

switch (subcommand) {
  case 'init':
    cmdInit(ticketId, args.slice(2));
    break;
  case 'current':
    cmdCurrent(ticketId, args.slice(2));
    break;
  case 'record-red':
    cmdRecordRed(ticketId, args.slice(2));
    break;
  case 'record-skip-red':
    cmdRecordSkipRed(ticketId, args.slice(2));
    break;
  case 'record-green':
    cmdRecordGreen(ticketId, args.slice(2));
    break;
  case 'record-refactor':
    cmdRecordRefactor(ticketId, args.slice(2));
    break;
  case 'transition':
    cmdTransition(ticketId, args[2], args.slice(2));
    break;
  case 'exception':
    cmdException(ticketId, args.slice(2));
    break;
  default:
    errorExit(
      `Unknown subcommand: ${subcommand}. ` +
        'Valid: init, current, record-red, record-skip-red, record-green, record-refactor, transition, exception'
    );
}

/**
 * Phase: completion_check — defensive duplicate of the check step's completion gate.
 *
 * Hard-blocks (NOT WAITs) unless `<tasksDir>/completion.check.md` exists AND
 * contains the canonical machine-readable line `**Status:** COMPLETE`. Cleanup
 * is destructive (branch/worktree/tmux teardown), so we fail CLOSED on a missing
 * file, an unreadable file, or a present-but-wrong/absent status line.
 *
 * Uses a dedicated STRICT regex — NOT the alias-resolving
 * `validateCheckReportStatus` — so `APPROVED` / `NOT_APPLICABLE` are rejected.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');

const CHECK_FILE = 'completion.check.md';

// Strict, canonical-only status matcher. Intentionally rejects the `APPROVED`
// and `NOT_APPLICABLE` aliases that `validateCheckReportStatus` would accept —
// destructive cleanup requires the exact `**Status:** COMPLETE` marker.
const STATUS_COMPLETE_RE = /^\s*\*\*Status:\*\*\s*COMPLETE\b/im;

function validate(ctx) {
  const checkPath = path.join(ctx.tasksDir, CHECK_FILE);

  if (!fs.existsSync(checkPath)) {
    return {
      ok: false,
      errors: [
        `Cannot verify ticket completion: ${CHECK_FILE} is missing from the tasks dir. ` +
          'Cleanup refuses destructive teardown without completion evidence. ' +
          'Repair: re-run the check step to regenerate the report, or restore the archived report.',
      ],
    };
  }

  let contents;
  try {
    contents = fs.readFileSync(checkPath, 'utf8');
  } catch {
    return {
      ok: false,
      errors: [
        `Cannot read ${CHECK_FILE}. Cleanup fails closed on an unreadable completion report. ` +
          'Repair: re-run the check step to regenerate the report, or restore the archived report.',
      ],
    };
  }

  if (!STATUS_COMPLETE_RE.test(contents)) {
    return {
      ok: false,
      errors: [
        `${CHECK_FILE} is missing the canonical **Status:** COMPLETE line ` +
          '(aliases such as APPROVED / NOT_APPLICABLE are not accepted). ' +
          'Repair: re-run the check step until it reports **Status:** COMPLETE, ' +
          'or restore the archived report.',
      ],
    };
  }

  return { ok: true, summary: `${CHECK_FILE} verified: **Status:** COMPLETE` };
}

function instructions(ctx) {
  return [
    '# cleanup-next — Phase 3 of 8: COMPLETION CHECK',
    `Ticket: ${ctx.ticket}`,
    '',
    'Defensive double-check: cleanup must only run on a COMPLETE ticket. If this ' +
      'blocks, your check step did not finalize completion.check.md — re-run it ' +
      'or restore the archived report before retrying cleanup.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CLEANUP_PHASES.completion_check, {
    next: CLEANUP_PHASES.branch_cleanup,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;

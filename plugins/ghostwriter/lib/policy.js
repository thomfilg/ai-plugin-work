'use strict';

/**
 * policy.js — the operator override, in one place.
 *
 * Every enforcement point honours the same escape hatch, and each one used to
 * spell it itself. Kept here so the guard, the file-content rules and the CLI
 * cannot drift into disagreeing about what lifts the rules.
 *
 * The override is read from the ENVIRONMENT the enforcement point inherited.
 * A value carried by the thing being inspected — an assignment in the command,
 * a line in the file — is not an override; it is the offence, spelled
 * differently. Callers that inspect text a command supplies check for that
 * separately (see guard.js `selfGranted`).
 */

const OVERRIDE_ENV = 'GHOSTWRITER_ALLOW_ATTRIBUTION';

/**
 * The line that identifies a git hook as ours. Shared because two sides depend
 * on it meaning the same thing: the installer writes it, and the guard reads
 * it to decide whether a `--no-verify` is removing a backstop or merely
 * skipping somebody else's linter.
 */
const COMMIT_MSG_MARKER = '# ghostwriter-commit-msg v1';

/** Has the operator lifted the rules for this process? */
function isOverridden(env) {
  return (env || {})[OVERRIDE_ENV] === '1';
}

module.exports = { OVERRIDE_ENV, COMMIT_MSG_MARKER, isOverridden };

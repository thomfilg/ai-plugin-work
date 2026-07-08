/**
 * Phase: screenshot — verify the agent captured visual evidence.
 *
 * Gate: at least one `.png` / `.jpg` / `.gif` file exists under
 * `tasksDir/screenshots/` AND the report references it.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QA_PHASES } = require('../../qa-phase-registry');

function listScreenshots(tasksDir) {
  const dir = path.join(tasksDir, 'screenshots');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
  } catch {
    return [];
  }
}

function validate(ctx) {
  const shots = listScreenshots(ctx.tasksDir);
  const errors = [];
  const warnings = [];
  if (!shots.length) {
    errors.push(
      `No screenshot files found under \`${path.join(ctx.tasksDir, 'screenshots')}\`. Capture at least one per QA kind so pr-post-generator can attach them.`
    );
    return { ok: false, errors, summary: 'no screenshots' };
  }
  // Check the report references at least one.
  const reportPath = path.join(ctx.tasksDir, 'qa-feature.check.md');
  let report = '';
  try {
    report = fs.readFileSync(reportPath, 'utf8');
  } catch {
    /* ignore */
  }
  const referenced = shots.filter((f) => report.includes(f));
  if (referenced.length === 0) {
    warnings.push(
      `Found ${shots.length} screenshot(s) but qa-feature.check.md does not reference any by filename. Add markdown image refs so they appear in the PR body.`
    );
  }
  return {
    ok: true,
    warnings,
    summary: `${shots.length} screenshot(s), ${referenced.length} referenced`,
  };
}

function instructions(ctx) {
  return [
    '# qa-next — Phase 6 of 9: SCREENSHOT',
    `Ticket: ${ctx.ticket}`,
    '',
    `Save screenshots under \`${path.join(ctx.tasksDir, 'screenshots')}/\` and reference them by filename in qa-feature.check.md (markdown image syntax). Capture at least:`,
    '- the happy-path success state',
    '- one edge state (empty, error, or loading)',
    '- any visual diff vs the spec (if you noticed one)',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.screenshot, {
    next: QA_PHASES.report,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.listScreenshots = listScreenshots;

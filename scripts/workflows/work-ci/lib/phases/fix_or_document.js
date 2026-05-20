/**
 * Phase: fix_or_document — for every regression, agent must record a fix
 * commit SHA; for every pre-existing, a documentation link.
 *
 * Auto-pass if no failures (ci-triage.json has empty classifications).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CI_PHASES } = require('../../ci-phase-registry');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function validate(ctx) {
  const status = readJson(path.join(ctx.tasksDir, 'ci-status.json'));
  if (!status || !status.failures || !status.failures.length) {
    return { ok: true, summary: 'no failures — auto-pass' };
  }
  const triage = readJson(path.join(ctx.tasksDir, 'ci-triage.json'));
  if (!triage) return { ok: false, errors: ['Missing ci-triage.json (re-run triage).'] };
  const errors = [];
  for (const c of triage.classifications || []) {
    if (c.category === 'regression') {
      if (!c.fixCommitSha || !/^[0-9a-f]{7,40}$/i.test(c.fixCommitSha)) {
        errors.push(
          `Regression \`${c.name}\` needs \`fixCommitSha\` (7-40 hex). Fix the source, commit, then update ci-triage.json with the commit SHA.`
        );
      }
    } else if (c.category === 'pre-existing') {
      if (!c.documentation || String(c.documentation).trim().length < 10) {
        errors.push(
          `Pre-existing failure \`${c.name}\` needs \`documentation\` field (≥ 10 chars; link to existing main failure or issue tracker).`
        );
      }
    } else if (c.category === 'flake') {
      // No artifact required — handled by rerun_check.
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    summary: `${triage.classifications.length} failure(s) addressed`,
  };
}

function instructions(ctx) {
  return [
    `# ci-next — Phase 4 of 8: FIX OR DOCUMENT`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    'For each entry in `ci-triage.json`:',
    '- `regression`: fix the source, commit, then patch the entry with `"fixCommitSha": "abc1234"`.',
    '- `pre-existing`: patch the entry with `"documentation": "<link or issue ID>"` explaining where it\'s also broken.',
    '- `flake`: nothing here — `rerun_check` handles it.',
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CI_PHASES.fix_or_document, {
    next: CI_PHASES.rerun_check,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;

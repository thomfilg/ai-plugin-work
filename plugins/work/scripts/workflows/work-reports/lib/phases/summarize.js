/**
 * Phase: summarize — extract the headline status from each indexed artifact.
 * Writes `reports-summary.json` (per-artifact verdict). No prose generation
 * here — that's the agent's job in the emit phase.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REPORTS_PHASES } = require('../../reports-phase-registry');

const STATUS_RE = /^Status:\s*(APPROVED|BLOCKED|COMPLETE|PASSED|FAILED|PENDING)\b/im;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function extractStatus(text) {
  if (!text) return null;
  const m = text.match(STATUS_RE);
  return m ? m[1].toUpperCase() : null;
}

function summarizeFiles(tasksDir, files) {
  const summary = [];
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(tasksDir, f), 'utf8');
    } catch {
      /* skip */
    }
    summary.push({ file: f, status: extractStatus(text), bytes: Buffer.byteLength(text) });
  }
  return summary;
}

function validate(ctx) {
  const ctxFile = path.join(ctx.tasksDir, 'reports-context.json');
  const snap = readJson(ctxFile);
  if (!snap || !Array.isArray(snap.files)) {
    return {
      ok: false,
      errors: ['`reports-context.json` missing or invalid — re-run collect_artifacts phase.'],
    };
  }
  const summary = summarizeFiles(ctx.tasksDir, snap.files);
  const blocked = summary.filter((s) => s.status === 'BLOCKED' || s.status === 'FAILED');
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, 'reports-summary.json'),
      JSON.stringify({ ticket: ctx.ticket, summary }, null, 2)
    );
  } catch {
    /* hook-gated; non-fatal */
  }
  return {
    ok: true,
    warnings: blocked.length
      ? [`${blocked.length} artifact(s) still BLOCKED/FAILED — flag in the final report.`]
      : [],
    summary: `summarized ${summary.length} artifact(s); ${blocked.length} blocking`,
  };
}

function instructions(ctx) {
  return [
    '# reports-next — Phase 3 of 6: SUMMARIZE',
    `Ticket: ${ctx.ticket}`,
    '',
    'I extract the `Status:` line from each artifact, write `reports-summary.json`.',
    'The agent narrates the headline summary in the next phase.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(REPORTS_PHASES.summarize, {
    next: REPORTS_PHASES.emit,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.summarizeFiles = summarizeFiles;
module.exports.extractStatus = extractStatus;
module.exports.STATUS_RE = STATUS_RE;

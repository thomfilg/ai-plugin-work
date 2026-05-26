/**
 * Phase: collect_artifacts — index every report-eligible file in tasksDir
 * and snapshot the inventory into `reports-context.json`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REPORTS_PHASES } = require('../../reports-phase-registry');

const ARTIFACT_PATTERNS = [
  /^brief\.md$/,
  /^spec\.md$/,
  /^tasks\.md$/,
  /^.*\.check\.md$/,
  /^task-review-(?:tests|code)\.md$/,
  /^pr-review\.check\.md$/,
  /^README\.md$/,
];

function listArtifacts(tasksDir) {
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (ARTIFACT_PATTERNS.some((re) => re.test(e.name))) out.push(e.name);
  }
  return out.sort();
}

function writeContext(ctx, files) {
  const p = path.join(ctx.tasksDir, 'reports-context.json');
  const payload = {
    ticket: ctx.ticket,
    fileCount: files.length,
    files,
    capturedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  } catch {
    /* hook-gated; non-fatal */
  }
}

function validate(ctx) {
  const files = listArtifacts(ctx.tasksDir);
  if (!files.length) {
    return { ok: false, errors: ['No reportable artifacts found in tasks dir.'] };
  }
  writeContext(ctx, files);
  return { ok: true, summary: `${files.length} artifact(s) indexed` };
}

function instructions(ctx) {
  return [
    '# reports-next — Phase 2 of 6: COLLECT ARTIFACTS',
    `Ticket: ${ctx.ticket}`,
    '',
    'I scan the tasks dir for brief/spec/tasks + *.check.md + task-review/pr-review reports.',
    'Snapshot recorded into `reports-context.json` for the summarize phase.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(REPORTS_PHASES.collect_artifacts, {
    next: REPORTS_PHASES.summarize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.listArtifacts = listArtifacts;
module.exports.ARTIFACT_PATTERNS = ARTIFACT_PATTERNS;

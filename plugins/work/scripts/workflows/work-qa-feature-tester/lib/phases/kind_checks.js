/**
 * Phase: kind_checks — fan-out per-task-kind QA validators.
 * Mirrors work-spec/lib/phases/kind_checks.js, records into qa-feature.check.md.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QA_PHASES } = require('../../qa-phase-registry');
const { getKindCheckRegistry } = require('../kind-checks/kind-registry');

const KIND_HEADER = '## QA kind verification';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function renderKindBlock(results) {
  const lines = [KIND_HEADER, ''];
  for (const r of results) {
    const status = r.ok ? '✓ ok' : '✗ blocking';
    lines.push(`- **${r.kind}** — ${status}: ${r.summary || ''}`);
    for (const w of r.warnings || []) lines.push(`  - warning: ${w}`);
    for (const e of r.errors || []) lines.push(`  - error: ${e}`);
  }
  lines.push('');
  return lines.join('\n');
}

function upsertKindSection(text, block) {
  if (!text) return block;
  const idx = text.indexOf(KIND_HEADER);
  if (idx === -1) return `${text.replace(/\s+$/, '')}\n\n${block}`;
  const after = text.slice(idx + KIND_HEADER.length);
  const nextHdr = after.match(/^##\s/m);
  const end = nextHdr ? idx + KIND_HEADER.length + nextHdr.index : text.length;
  return text.slice(0, idx) + block + text.slice(end);
}

function writeKindSection(tasksDir, results) {
  const p = path.join(tasksDir, 'qa-feature.check.md');
  const text = readFile(p);
  const next = upsertKindSection(text, renderKindBlock(results));
  if (next !== text) {
    try {
      fs.writeFileSync(p, next);
    } catch {
      /* hook-gated */
    }
  }
}

function validate(ctx) {
  const registry = getKindCheckRegistry();
  const matched = [];
  for (const [kind, h] of Object.entries(registry)) {
    let applies = false;
    try {
      applies = Boolean(h.appliesTo(ctx));
    } catch {
      applies = false;
    }
    if (applies) matched.push({ kind, h });
  }
  const results = [];
  for (const { kind, h } of matched) {
    let r;
    try {
      r = h.validate(ctx);
    } catch (e) {
      r = { ok: false, errors: [`kind-check "${kind}" threw: ${e.message}`] };
    }
    results.push({ kind, ...r });
  }
  if (results.length) writeKindSection(ctx.tasksDir, results);
  const allErrors = results.flatMap((r) => (r.ok ? [] : r.errors || []));
  if (allErrors.length) {
    return {
      ok: false,
      errors: allErrors,
      summary: `${results.filter((r) => r.ok).length}/${results.length} kinds passing`,
    };
  }
  return {
    ok: true,
    summary: `${results.length} kind check(s) passed (${results.map((r) => r.kind).join(', ') || 'none applied'})`,
  };
}

function instructions(ctx) {
  return [
    '# qa-next — Phase 5 of 9: KIND CHECKS',
    `Ticket: ${ctx.ticket}`,
    '',
    '### Per task kind',
    '- **frontend**: `### Frontend QA` section with loading/empty/error/success checklist (all checked).',
    '- **backend**: `### Backend QA` with happy + error responses, HTTP status codes cited.',
    '- **wiring**: `### Wiring QA` confirming end-to-end data flow without sibling drift.',
    '- **e2e**: `### E2E QA` with playwright command + passing-test confirmation.',
    '- **devops**: `### DevOps QA` with workflow URL / script run + exit code 0.',
    '- **fullstack**: frontend + backend + network/fetch evidence.',
    '',
    'Recorded under `## QA kind verification` in qa-feature.check.md.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(QA_PHASES.kind_checks, {
    next: QA_PHASES.screenshot,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.renderKindBlock = renderKindBlock;
module.exports.upsertKindSection = upsertKindSection;
module.exports.KIND_HEADER = KIND_HEADER;

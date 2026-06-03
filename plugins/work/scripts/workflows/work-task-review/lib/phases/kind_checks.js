/**
 * Phase: kind_checks — fan-out per-task-kind validators for task-review.
 * Mirrors work-pr-reviewer/lib/phases/kind_checks.js, records into
 * `task-review.check.md`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { TASK_REVIEW_PHASES } = require('../../task-review-phase-registry');
const { getKindCheckRegistry } = require('../kind-checks/kind-registry');
const { preflightTasksManifest } = require('../kind-checks/shared');

const KIND_HEADER = '## Per-kind verification';

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
  const p = path.join(tasksDir, 'task-review.check.md');
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
  const pre = preflightTasksManifest(ctx.tasksDir);
  if (!pre.ok) {
    return {
      ok: false,
      errors: [pre.error],
      summary: 'tasks.md malformed — no recognized ### Type headers (bypass guard)',
    };
  }
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
    '# task-review-next — Phase 4 of 8: KIND CHECKS',
    `Ticket: ${ctx.ticket}`,
    '',
    'task_review scope = THIS task only (smaller than code-checker / pr-reviewer).',
    '',
    '### Per task kind',
    '- **frontend**: companion test, inline-style drift, cross-kind backend drift.',
    '- **backend**: companion test, `any`/`@ts-ignore`, schema-without-migration.',
    '- **wiring**: ECHO-4579 backend drift; per-task size sanity.',
    '- **e2e**: `.only`, hardcoded `waitForTimeout`, missing `expect(`.',
    '- **devops**: secret-shaped literals, unpinned action refs, app-source drift.',
    '- **fullstack**: frontend + backend.',
    '',
    'Recorded under `## Per-kind verification` in task-review.check.md.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(TASK_REVIEW_PHASES.kind_checks, {
    next: TASK_REVIEW_PHASES.coverage,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.renderKindBlock = renderKindBlock;
module.exports.upsertKindSection = upsertKindSection;
module.exports.KIND_HEADER = KIND_HEADER;

/**
 * Phase: kind_checks — fan-out per-task-kind completion validators.
 *
 * Mirrors work-spec/lib/phases/kind_checks.js. Records the aggregate
 * verdict into a `## Completion kind verification` block in
 * completion.check.md so the audit is durable artifact-side.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { getKindCheckRegistry } = require('../kind-checks/kind-registry');
const { preflightTasksManifest } = require('../kind-checks/shared');

const KIND_HEADER = '## Completion kind verification';

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
  const p = path.join(tasksDir, 'completion.check.md');
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
    '# completion-next — Phase 8 of 11: KIND CHECKS',
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check (per task kind)',
    '- **frontend**: diff contains components/pages, UI states from tasks.md present in changed files.',
    '- **backend**: diff contains backend files + at least one integration test; Requirement Coverage all DELIVERED.',
    '- **wiring**: ECHO-4579 defense — no backend files in diff when brief forbids backend changes.',
    '- **e2e**: diff contains a Playwright spec under `tests/e2e/`; at least one `@e2e` tagged scenario.',
    '- **devops**: only infra files (`.github/`, `scripts/`, `*.yml`, Dockerfile); no app-source drift.',
    '- **fullstack**: runs frontend + backend, plus cross-cut (UI ↔ API both shipped).',
    '',
    'Recorded under `## Completion kind verification` in `completion.check.md`.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.kind_checks, {
    next: COMPLETION_PHASES.report,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.renderKindBlock = renderKindBlock;
module.exports.upsertKindSection = upsertKindSection;
module.exports.KIND_HEADER = KIND_HEADER;

/**
 * Phase: kind_checks — fan-out per-task-kind code-quality validators.
 * Mirrors work-spec/lib/phases/kind_checks.js but writes to
 * code-review.check.md.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CODE_PHASES } = require('../../code-phase-registry');
const { getKindCheckRegistry } = require('../kind-checks/kind-registry');
const { preflightTasksManifest } = require('../kind-checks/shared');

const KIND_HEADER = '## Code-quality kind verification';

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
  const p = path.join(tasksDir, 'code-review.check.md');
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
    '# code-next — Phase 5 of 8: KIND CHECKS',
    `Ticket: ${ctx.ticket}`,
    '',
    '### Per task kind',
    '- **frontend**: TS safety in components, `console.log` left in, missing companion tests.',
    '- **backend**: TS safety in routes/schemas, missing Zod validation at boundaries, missing integration test.',
    '- **wiring**: TS safety, ECHO-4579 backend drift, large files / TODOs in supposedly-small wiring.',
    '- **e2e**: `.only` left in, no `expect(`, hardcoded `page.waitForTimeout`.',
    '- **devops**: shells without `set -euo pipefail`, long inline `run:` blocks, app-source drift.',
    '- **fullstack**: runs frontend + backend.',
    '',
    'Recorded under `## Code-quality kind verification` in `code-review.check.md`.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CODE_PHASES.kind_checks, {
    next: CODE_PHASES.report,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.renderKindBlock = renderKindBlock;
module.exports.upsertKindSection = upsertKindSection;
module.exports.KIND_HEADER = KIND_HEADER;

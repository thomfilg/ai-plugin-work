/**
 * Phase: kind_checks — dispatch per-task-kind validators.
 *
 * Detects task kinds from spec.md (or tasks.md if produced) and runs each
 * matching kind's `validate(ctx)` from `lib/kind-checks/`. Errors aggregate;
 * default is collect-all-then-block.
 *
 * Recorded artifact: `## Kind verification` section in spec.md.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SPEC_PHASES } = require('../../spec-phase-registry');
const { getKindCheckRegistry } = require('../kind-checks/kind-registry');

const KIND_HEADER = '## Kind verification';

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

function upsertKindSection(specText, block) {
  if (!specText) return block;
  const idx = specText.indexOf(KIND_HEADER);
  if (idx === -1) return `${specText.replace(/\s+$/, '')}\n\n${block}`;
  const after = specText.slice(idx + KIND_HEADER.length);
  const nextHdr = after.match(/^##\s/m);
  const end = nextHdr ? idx + KIND_HEADER.length + nextHdr.index : specText.length;
  return specText.slice(0, idx) + block + specText.slice(end);
}

function writeKindSection(tasksDir, results) {
  const specPath = path.join(tasksDir, 'spec.md');
  const spec = readFile(specPath);
  const next = upsertKindSection(spec, renderKindBlock(results));
  if (next !== spec) {
    try {
      fs.writeFileSync(specPath, next);
    } catch {
      /* hook-gated — fail-open. */
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
    `# spec-next — Phase 7 of 8: KIND CHECKS`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What I check',
    'For each task kind present in this spec (frontend / backend / wiring / e2e / devops / fullstack), I run a kind-specific validator. Errors block; warnings are recorded but allow advance.',
    '',
    '- **frontend**: target component file(s), test scenarios for loading/empty/error, no backend-schema drift.',
    '- **backend**: tRPC procedure / route handler, input/output schema refs, integration test, security considerations.',
    '- **wiring**: ECHO-4579 defense — if brief says "no backend changes" and spec lists backend files in Files to Create/Modify, BLOCK.',
    '- **e2e**: Playwright spec ref, journey/page-object refs, ≥1 `@e2e` Gherkin scenario.',
    '- **devops**: only `.github/` / `scripts/` / infra config files touched; any app/lib touch is flagged.',
    '- **fullstack**: runs frontend + backend + cross-cut (every backend field referenced by frontend is in verified surface).',
    '',
    'Recorded as `## Kind verification` in spec.md.',
    '',
    'Re-invoke me after addressing any errors.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(SPEC_PHASES.kind_checks, {
    next: SPEC_PHASES.done,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.renderKindBlock = renderKindBlock;
module.exports.upsertKindSection = upsertKindSection;
module.exports.KIND_HEADER = KIND_HEADER;

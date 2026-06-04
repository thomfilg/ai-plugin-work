/**
 * Phase: report — confirm completion.check.md was actually produced and
 * matches the canonical structure (Original Request, Deliverables Checklist,
 * Final Status). Also persists `completion-verdict.json` and upserts a
 * `## Reuse / Scope / Test-pass verification` block into completion.check.md
 * so downstream gates can consume structured failure records without
 * re-parsing markdown (R7).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readState } = require('../failure-store');

const REQUIRED_SECTIONS = ['Requirements Verification', 'Deliverables Checklist', 'Final Status'];
const VERIFICATION_HEADER = '## Reuse / Scope / Test-pass verification';

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function dedupeFailures(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    if (!r) continue;
    // Match on the full enforcement contract — two records that report the
    // same (requirementId, checkType, expected, observed, file, line) are the
    // same finding regardless of which array they came from (ctx.failures
    // from the current invocation vs. failure-store from a prior phase).
    const key = JSON.stringify([
      r.requirementId,
      r.checkType,
      r.expected,
      r.observed,
      r.file,
      r.line,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function buildVerdictDocument(ctx) {
  // ctx.failures only holds records from THIS phase-runner invocation;
  // earlier enforcement phases (reuse_audit / suggested_scope / test_pass)
  // ran in prior invocations with their own ctx (see create-phase-runner.js
  // ~line 210). failure-store persists their records to disk so we can fold
  // them in here.
  const store = readState(ctx.tasksDir);
  const inMemory = Array.isArray(ctx.failures) ? ctx.failures : [];
  const failures = dedupeFailures([...store.failures, ...inMemory]);
  const summary = ctx.summaryCounters || {
    reuseChecked: ctx.reuseAuditChecked ?? store.summary.reuseChecked ?? 0,
    scopeChecked: ctx.scopeChecked ?? store.summary.scopeChecked ?? 0,
    testsChecked: ctx.testsChecked ?? store.summary.testsChecked ?? 0,
  };
  return {
    ticket: ctx.ticket,
    ok: failures.length === 0,
    verdictAt: new Date().toISOString(),
    failures,
    summary,
  };
}

function renderVerificationBlock(verdict) {
  const lines = [VERIFICATION_HEADER, ''];
  lines.push(`- ok: ${verdict.ok}`);
  lines.push(`- verdictAt: ${verdict.verdictAt}`);
  lines.push(
    `- summary: reuseChecked=${verdict.summary.reuseChecked || 0}, scopeChecked=${verdict.summary.scopeChecked || 0}, testsChecked=${verdict.summary.testsChecked || 0}`
  );
  if (verdict.failures.length === 0) {
    lines.push('- failures: none');
  } else {
    lines.push('- failures:');
    for (const f of verdict.failures) {
      lines.push(
        `  - ${f.requirementId} [${f.checkType}] expected: ${f.expected}; observed: ${f.observed}`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function upsertVerificationSection(text, block) {
  // Don't conjure completion.check.md from nothing — when the report file is
  // absent, the verification block has no host. Returning null keeps the
  // "Missing completion.check.md" diagnostic intact downstream.
  if (!text) return null;
  const idx = text.indexOf(VERIFICATION_HEADER);
  if (idx === -1) return `${text.replace(/\s+$/, '')}\n\n${block}`;
  const after = text.slice(idx + VERIFICATION_HEADER.length);
  const nextHdr = after.match(/^##\s/m);
  const end = nextHdr ? idx + VERIFICATION_HEADER.length + nextHdr.index : text.length;
  return text.slice(0, idx) + block + text.slice(end);
}

function persistVerdict(ctx) {
  const verdict = buildVerdictDocument(ctx);
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, 'completion-verdict.json'),
      `${JSON.stringify(verdict, null, 2)}\n`
    );
  } catch {
    /* hook-gated */
  }
  const completionPath = path.join(ctx.tasksDir, 'completion.check.md');
  const text = readFile(completionPath);
  const next = upsertVerificationSection(text, renderVerificationBlock(verdict));
  if (next !== null && next !== text) {
    try {
      fs.writeFileSync(completionPath, next);
    } catch {
      /* hook-gated */
    }
  }
  return verdict;
}

function summarizeVerdictFailures(verdict) {
  const counts = new Map();
  for (const f of verdict.failures) {
    counts.set(f.checkType, (counts.get(f.checkType) || 0) + 1);
  }
  const parts = [];
  for (const [k, n] of counts) parts.push(`${k}=${n}`);
  return parts.join(', ');
}

function validate(ctx) {
  const verdict = persistVerdict(ctx);
  // Review feedback: previously the report phase only checked that
  // completion.check.md had the right shape. If an earlier enforcement phase
  // (reuse_audit / suggested_scope / test_pass) wrote failures to the store
  // and `writeState` then silently failed downstream, the pipeline could
  // still advance even though `completion-verdict.json` said `ok: false`.
  // The verdict is now the source of truth: if it has any failure records,
  // report fails closed with a summary referencing the persisted JSON.
  if (verdict && verdict.ok === false) {
    return {
      ok: false,
      errors: [
        `completion-verdict.json reports ${verdict.failures.length} unresolved failure(s) [${summarizeVerdictFailures(verdict)}]. Resolve them before advancing.`,
      ],
    };
  }
  const p = path.join(ctx.tasksDir, 'completion.check.md');
  const text = readFile(p);
  if (!text) {
    return {
      ok: false,
      errors: [`Missing ${p}. Write the completion report there.`],
    };
  }
  const missing = REQUIRED_SECTIONS.filter((s) => !text.includes(s));
  if (missing.length) {
    return {
      ok: false,
      errors: [
        `completion.check.md is missing required section(s): ${missing.join(', ')}. Match the structure in agents/completion-checker.md.`,
      ],
    };
  }
  if (/\[INCOMPLETE/i.test(text)) {
    return {
      ok: false,
      errors: [
        'completion.check.md final status reads INCOMPLETE. Resolve the missing deliverables before advancing.',
      ],
    };
  }
  return { ok: true, summary: `${text.length} chars, all required sections present` };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 9 of 11: REPORT',
    `Ticket: ${ctx.ticket}`,
    '',
    `Write \`${path.join(ctx.tasksDir, 'completion.check.md')}\` with the canonical structure from agents/completion-checker.md:`,
    '',
    '```markdown',
    '## Requirements Verification',
    '',
    '### Original Request:',
    '...',
    '',
    '### Deliverables Checklist:',
    '- [x] Requirement 1 - DELIVERED: <code citation>',
    '',
    '### Final Status:',
    '[COMPLETE]',
    '```',
    '',
    'If you arrive at INCOMPLETE, you must NOT advance — fix the deliverables and re-invoke me.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.report, {
    next: COMPLETION_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.REQUIRED_SECTIONS = REQUIRED_SECTIONS;
module.exports.VERIFICATION_HEADER = VERIFICATION_HEADER;
module.exports.buildVerdictDocument = buildVerdictDocument;
module.exports.upsertVerificationSection = upsertVerificationSection;

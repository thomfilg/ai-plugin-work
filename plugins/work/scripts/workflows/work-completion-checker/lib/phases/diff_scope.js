/**
 * Phase: diff_scope — Gate E (scope-diff verification).
 *
 * Classifies every changed file as in-scope / out-of-scope (sibling-owned) /
 * unaccounted (not in any task's `### Files in scope`). out-of-scope > 0
 * BLOCKS completion (the ECHO-4579 lesson). unaccounted > 0 surfaces as a
 * warning the agent must justify.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readChangedFiles, readTasks, sliceSection } = require('../kind-checks/shared');

function parseFilesInScope(tasksText) {
  const out = new Set();
  if (!tasksText) return out;
  // Pull every `### Files in scope` block from every task.
  const re = /^###\s+Files in scope\b[\s\S]*?(?=\n###\s|\n## |$(?![\s\S]))/gim;
  let m;
  while ((m = re.exec(tasksText)) !== null) {
    for (const line of m[0].split('\n')) {
      const b = line.match(/`([^`\n]+)`/g);
      if (!b) continue;
      for (const tok of b) out.add(tok.replace(/`/g, '').trim());
    }
  }
  return out;
}

function parseFilesOutOfScope(tasksText) {
  const out = new Set();
  if (!tasksText) return out;
  const block = sliceSection(tasksText, /^###\s+Files explicitly out of scope\b/im);
  if (!block) return out;
  for (const line of block.split('\n')) {
    const b = line.match(/`([^`\n]+)`/g);
    if (!b) continue;
    for (const tok of b) out.add(tok.replace(/`/g, '').trim());
  }
  return out;
}

function classify(ctx) {
  const tasksText = readTasks(ctx.tasksDir);
  const inScope = parseFilesInScope(tasksText);
  const outOfScope = parseFilesOutOfScope(tasksText);
  const changed = readChangedFiles(ctx);
  const inList = [];
  const outList = [];
  const unaccounted = [];
  for (const f of changed) {
    if (outOfScope.has(f)) outList.push(f);
    else if (inScope.has(f)) inList.push(f);
    else unaccounted.push(f);
  }
  return { inScope: inList, outOfScope: outList, unaccounted, total: changed.length };
}

const CTX_FILE = 'completion-scope.json';

function validate(ctx) {
  const r = classify(ctx);
  const errors = [];
  const warnings = [];
  if (r.outOfScope.length) {
    errors.push(
      `Gate E: ${r.outOfScope.length} sibling-owned (out of scope) file(s) modified: ${r.outOfScope
        .map((f) => `\`${f}\``)
        .join(', ')}. BLOCK completion — revert these edits or file a sibling-gap question.`
    );
  }
  if (r.unaccounted.length) {
    warnings.push(
      `Gate E: ${r.unaccounted.length} unaccounted file(s) (not declared in any task's \`### Files in scope\`): ${r.unaccounted
        .slice(0, 5)
        .map((f) => `\`${f}\``)
        .join(
          ', '
        )}${r.unaccounted.length > 5 ? ', …' : ''}. Justify each in the PR description under \`## Out-of-scope changes\` or revert.`
    );
  }
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, CTX_FILE),
      JSON.stringify({ ...r, snapshotAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* hook-gated; non-fatal */
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `in:${r.inScope.length} out:${r.outOfScope.length} unaccounted:${r.unaccounted.length} (of ${r.total})`,
  };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 3 of 8: DIFF SCOPE (Gate E)',
    `Ticket: ${ctx.ticket}`,
    '',
    'I classify every changed file against:',
    '- `### Files in scope` blocks across all tasks in tasks.md',
    '- `### Files explicitly out of scope` (sibling-owned)',
    '',
    'Out-of-scope > 0 → BLOCK. Unaccounted > 0 → must justify or revert.',
    '',
    'Re-invoke me after addressing the gate.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.diff_scope, {
    next: COMPLETION_PHASES.coverage_check,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.classify = classify;
module.exports.parseFilesInScope = parseFilesInScope;
module.exports.parseFilesOutOfScope = parseFilesOutOfScope;
module.exports.CTX_FILE = CTX_FILE;

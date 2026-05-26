/**
 * Phase: report — confirm code-review.check.md has the canonical sections
 * from agents/code-checker.md: Overall Assessment, Confidence, Policy
 * Compliance Summary table.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CODE_PHASES } = require('../../code-phase-registry');

const REQUIRED_SECTIONS = ['Overall Assessment', 'Policy Compliance Summary', 'Confidence'];

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function validate(ctx) {
  const p = path.join(ctx.tasksDir, 'code-review.check.md');
  const text = readFile(p);
  if (!text) {
    return { ok: false, errors: [`Missing ${p}.`] };
  }
  const missing = REQUIRED_SECTIONS.filter((s) => !text.includes(s));
  if (missing.length) {
    return {
      ok: false,
      errors: [
        `code-review.check.md is missing section(s): ${missing.join(', ')}. Match the structure in agents/code-checker.md.`,
      ],
    };
  }
  // Hard-block any 🔴 Critical that hasn't been resolved.
  const critical = (text.match(/🔴\s*Critical/gi) || []).length;
  const verdictFail = /Overall\s*Assessment.*❌/i.test(text);
  if (critical > 0 && verdictFail) {
    return {
      ok: false,
      errors: [
        `Report has ${critical} 🔴 Critical issue(s) AND ❌ overall verdict. Address criticals before advancing.`,
      ],
    };
  }
  return { ok: true, summary: `${text.length} chars, all required sections present` };
}

function instructions(ctx) {
  return [
    '# code-next — Phase 6 of 8: REPORT',
    `Ticket: ${ctx.ticket}`,
    '',
    `Fill out \`${path.join(ctx.tasksDir, 'code-review.check.md')}\` with the canonical structure from agents/code-checker.md:`,
    '',
    '```',
    '## Overall Assessment: ✅ / ⚠️ / 🔧 / ❌',
    'Confidence: High / Medium / Low',
    '',
    '## Policy Compliance Summary',
    '| Area | Status |',
    '| --- | --- |',
    '| Task-Doc Compliance | Pass / Partial / Fail / N/A |',
    '| Code Reuse | Pass / Partial / Fail |',
    '| ... | ... |',
    '',
    '## Strengths',
    '## Issues Found',
    '## Recommended Refactors',
    '## Next Steps',
    '```',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CODE_PHASES.report, {
    next: CODE_PHASES.memorize,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.REQUIRED_SECTIONS = REQUIRED_SECTIONS;

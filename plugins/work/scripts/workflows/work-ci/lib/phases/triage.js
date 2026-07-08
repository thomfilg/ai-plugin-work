/**
 * Phase: triage — classify each failure as `regression` (introduced here),
 * `pre-existing` (also fails on main), or `flake`. Agent records the
 * classification in `ci-triage.json`.
 *
 * Auto-pass: if ci-status.json shows zero failures.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { CI_PHASES } = require('../../ci-phase-registry');

const TRIAGE_FILE = 'ci-triage.json';
const VALID_CATEGORIES = ['regression', 'pre-existing', 'flake', 'cache-miss'];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function validate(ctx) {
  const status = readJson(path.join(ctx.tasksDir, 'ci-status.json'));
  if (!status) return { ok: false, errors: ['Missing ci-status.json (re-run wait).'] };
  if (!status.failures || !status.failures.length) {
    return { ok: true, summary: 'no failures — auto-pass' };
  }
  const triage = readJson(path.join(ctx.tasksDir, TRIAGE_FILE));
  if (!triage || !Array.isArray(triage.classifications)) {
    return {
      ok: false,
      errors: [
        `${status.failures.length} CI failure(s) need triage. Create ${TRIAGE_FILE} with \`{ "classifications": [{ "name": "...", "category": "${VALID_CATEGORIES.join('|')}", "evidence": "..." }] }\`.`,
      ],
    };
  }
  const byName = Object.fromEntries(triage.classifications.map((c) => [c.name, c]));
  const errors = [];
  for (const f of status.failures) {
    const t = byName[f.name];
    if (!t) {
      errors.push(
        `Failure \`${f.name}\` is not classified in ${TRIAGE_FILE}. Add an entry with category and evidence.`
      );
      continue;
    }
    if (!VALID_CATEGORIES.includes(t.category)) {
      errors.push(
        `Failure \`${f.name}\` has invalid category "${t.category}". Use one of: ${VALID_CATEGORIES.join(', ')}.`
      );
    }
    if (t.category === 'cache-miss' && typeof t.upstreamProducerPassed !== 'boolean') {
      errors.push(
        `Failure \`${f.name}\` is category "cache-miss" but is missing required boolean field \`upstreamProducerPassed\`. Set it to true when the upstream cache-producer job passed (downstream missed the cache) or false when the producer also failed.`
      );
    }
    if (!t.evidence || String(t.evidence).trim().length < 10) {
      errors.push(
        `Failure \`${f.name}\` needs concrete \`evidence\` (≥ 10 chars). For pre-existing: link to a main-branch failure. For regression: name the file/commit. For flake: cite prior flake history.`
      );
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, summary: `${triage.classifications.length} failure(s) triaged` };
}

function instructions(ctx) {
  return [
    `# ci-next — Phase 3 of 8: TRIAGE`,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What you do',
    `Classify every failure from ci-status.json into ${TRIAGE_FILE}:`,
    '',
    '```json',
    '{',
    '  "classifications": [',
    '    {',
    '      "name": "test-foo",',
    '      "category": "regression",',
    '      "evidence": "introduced in commit abc1234; broke when X was added"',
    '    },',
    '    {',
    '      "name": "flaky-network-test",',
    '      "category": "flake",',
    '      "evidence": "test failed on 3 unrelated PRs last week; passes on retry"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Categories:',
    '- `regression`: introduced by this branch. Must be fixed in `fix_or_document`.',
    '- `pre-existing`: also fails on `main`. Document with link.',
    '- `flake`: known flake. Re-run.',
    '- `cache-miss`: a downstream job failed because a CI cache layer was missing.',
    '  REQUIRES additional boolean field `upstreamProducerPassed`:',
    '    - `true`  → the upstream cache-producer job passed; downstream just missed the cache.',
    '              Routes to a full `gh run rerun <run-id>` (NOT `--failed`) in fix_or_document.',
    '    - `false` → the upstream producer also failed; treat as a normal regression/pre-existing.',
    '',
    '`evidence` is required and must be ≥ 10 chars of concrete reasoning.',
    '',
    'Re-invoke me to verify.',
    '',
  ].join('\n');
}

module.exports = function register(r) {
  r(CI_PHASES.triage, {
    next: CI_PHASES.fix_or_document,
    validate,
    instructions,
  });
};
module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.TRIAGE_FILE = TRIAGE_FILE;

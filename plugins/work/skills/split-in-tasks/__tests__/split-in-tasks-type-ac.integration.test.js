'use strict';

/**
 * split-in-tasks-type-ac integration — wires lintTypeAcConsistency into
 * emit-warnings.js aggregation pipeline.
 *
 * Spawn-based end-to-end test (mirrors split-in-tasks-warnings.test.js
 * pattern, using child_process.spawn + fs.mkdtempSync). Verifies:
 *
 *   (a) Mismatched fixture (Type=wiring + docs-exemption AC) causes the
 *       skill aggregation to exit non-zero AND stdout/stderr contains
 *       both the offending AC line substring and the hint
 *       `propose Type: docs`.
 *   (b) Same fixture with Type=docs exits zero AND emits no kind-`D`
 *       SPLIT-WARNING.
 *
 * The aggregation entry-point under test is `emit-warnings.js` invoked as
 * a CLI against a ticket directory containing tasks.md. RED-phase: that
 * entry-point does not yet require lint-type-ac-consistency.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const EMIT_WARNINGS = path.resolve(__dirname, '..', 'lib', 'emit-warnings.js');

// The skill's library is intentionally pure (no console.* / process.exit),
// so the integration test spawns a tiny driver that requires
// emit-warnings.js, prints aggregated kind-D warnings, and exits non-zero
// when any are produced. This mirrors how the operator-facing split-in-tasks
// flow surfaces warnings.
const DRIVER = `
const { aggregateTypeAcWarnings, formatWarnings } = require(${JSON.stringify(EMIT_WARNINGS)});
const ticketDir = process.argv[process.argv.length - 1];
const warnings = aggregateTypeAcWarnings(ticketDir);
if (warnings.length > 0) {
  process.stdout.write(formatWarnings(warnings) + '\\n');
  process.exit(1);
}
process.exit(0);
`;

const DOCS_EXEMPTION_AC = 'documentation/manifest only — no RED/GREEN/REFACTOR cycle required';

function buildTasksMd({ type }) {
  // Scope choice depends on Type — Pass D now enforces per-Type scope
  // allowlists. For Type=docs the scope must consist of *.md files; for
  // any other Type, src/b.js is a non-test source entry that satisfies
  // the docs-exemption Type-mismatch check we care about here.
  const scopeEntries = type === 'docs' ? ['- README.md'] : ['- src/b.js'];
  return [
    '# Tasks',
    '',
    '## Task 1 — sample wiring task',
    '',
    '### Type',
    type,
    '',
    '### Description',
    'A task whose AC declares docs-exemption.',
    '',
    '### Acceptance Criteria',
    `- ${DOCS_EXEMPTION_AC}`,
    '- Module B re-exports A.',
    '',
    '### Files in scope',
    ...scopeEntries,
    '',
  ].join('\n');
}

function makeTicketDir({ type }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-type-ac-'));
  fs.writeFileSync(path.join(dir, 'tasks.md'), buildTasksMd({ type }), 'utf8');
  return dir;
}

function runEmitWarnings(ticketDir) {
  return spawnSync('node', ['-e', DRIVER, '--', ticketDir], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('split-in-tasks aggregation — Type/AC consistency (kind D)', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {
        /* best-effort cleanup */
      }
    }
  });

  it('split-in-tasks rejects Type=wiring on an AC declaring docs-exemption', () => {
    const ticketDir = makeTicketDir({ type: 'wiring' });
    dirs.push(ticketDir);

    const result = runEmitWarnings(ticketDir);

    assert.notEqual(
      result.status,
      0,
      `expected emit-warnings to exit non-zero on mismatched fixture; got status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`
    );
    const blob = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.match(
      blob,
      /documentation\/manifest only/i,
      `expected offending AC line substring in output; got: ${blob}`
    );
    assert.match(
      blob,
      /propose Type:\s*docs/i,
      `expected hint 'propose Type: docs' in output; got: ${blob}`
    );
    assert.match(blob, /\bTask\s*1\b/, `expected task number reference in output; got: ${blob}`);
  });

  it('split-in-tasks accepts Type=docs on the same AC', () => {
    const ticketDir = makeTicketDir({ type: 'docs' });
    dirs.push(ticketDir);

    const result = runEmitWarnings(ticketDir);

    assert.equal(
      result.status,
      0,
      `expected emit-warnings to exit 0 on docs fixture; got status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`
    );
    const blob = `${result.stdout || ''}\n${result.stderr || ''}`;
    assert.doesNotMatch(
      blob,
      /propose Type:\s*docs/i,
      `expected no kind-D 'propose Type: docs' hint on happy-path; got: ${blob}`
    );
    assert.doesNotMatch(
      blob,
      /\[Pass D\]/,
      `expected no '[Pass D]' marker on happy-path; got: ${blob}`
    );
  });
});

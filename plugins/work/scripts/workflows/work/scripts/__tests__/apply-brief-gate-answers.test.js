/**
 * Tests for apply-brief-gate-answers.js (GH-543, PR1) — the file/stdin CLI
 * transport that replaces both argv-JSON resolution transports.
 *
 * Covers:
 *   - default answers-file path (<dirname(briefPath)>/.brief-gate-answers.json)
 *   - --stdin transport
 *   - answers file deleted ONLY on full apply (partial apply keeps it and
 *     reports skipped keys)
 *   - exit codes 0/1
 *   - malformed JSON → exit 1, brief.md untouched
 *
 * Run: node --test scripts/workflows/work/scripts/__tests__/apply-brief-gate-answers.test.js
 */

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'apply-brief-gate-answers.js');

const OPEN_Q = 'Which queue backend should we adopt for cross-service jobs?';

const BRIEF = [
  '# Brief',
  '',
  '## Open Questions',
  '',
  `- **Question:** ${OPEN_Q}`,
  '  - `scope: architectural`',
  '  - `rationale: affects all downstream services`',
  '  - `resolved: false`',
  '',
  '## Out of scope (sibling-owned)',
  '- `lib/x.ts` — owned by GH-100. Reason: read path missing.',
  '',
].join('\n');

const createdDirs = [];

function makeFixture({ answers } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-answers-cli-'));
  createdDirs.push(dir);
  const briefPath = path.join(dir, 'brief.md');
  fs.writeFileSync(briefPath, BRIEF, 'utf8');
  const answersPath = path.join(dir, '.brief-gate-answers.json');
  if (answers !== undefined) {
    fs.writeFileSync(answersPath, answers, 'utf8');
  }
  return { dir, briefPath, answersPath };
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
}

afterEach(() => {
  while (createdDirs.length) {
    fs.rmSync(createdDirs.pop(), { recursive: true, force: true });
  }
});

describe('apply-brief-gate-answers CLI', () => {
  it('reads the default .brief-gate-answers.json, applies it, deletes it, exits 0', () => {
    const envelope = {
      openQuestions: { [OPEN_Q]: 'Use SQS.' },
      siblingGaps: [{ surface: 'lib/x.ts', decision: 'wait-for-sibling' }],
    };
    const { briefPath, answersPath } = makeFixture({ answers: JSON.stringify(envelope) });

    const res = runCli([briefPath]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);

    const updated = fs.readFileSync(briefPath, 'utf8');
    assert.match(updated, /\*\*Resolution:\*\* Use SQS\./);
    assert.match(updated, /- `lib\/x\.ts` — decision: wait-for-sibling/);
    assert.equal(fs.existsSync(answersPath), false, 'answers file must be consumed on full apply');

    const summary = JSON.parse(res.stdout);
    assert.equal(summary.changed, true);
    assert.equal(summary.deletedAnswersFile, true);
  });

  it('reads the envelope from --stdin without touching any answers file', () => {
    const { briefPath, answersPath } = makeFixture();
    const envelope = { openQuestions: { [OPEN_Q]: 'Use SQS.' } };

    const res = runCli([briefPath, '--stdin'], { input: JSON.stringify(envelope) });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(fs.readFileSync(briefPath, 'utf8'), /\*\*Resolution:\*\* Use SQS\./);
    assert.equal(fs.existsSync(answersPath), false);
  });

  it('reads from an explicit --file path', () => {
    const { dir, briefPath } = makeFixture();
    const altPath = path.join(dir, 'alt-answers.json');
    fs.writeFileSync(altPath, JSON.stringify({ openQuestions: { [OPEN_Q]: 'Use SQS.' } }));

    const res = runCli([briefPath, '--file', altPath]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(fs.existsSync(altPath), false, 'explicit answers file is consumed too');
  });

  it('keeps the answers file and lists skipped keys on partial apply, exits 1', () => {
    const envelope = {
      openQuestions: {
        [OPEN_Q]: 'Use SQS.',
        'A question the brief does not contain?': 'orphan answer',
      },
    };
    const { briefPath, answersPath } = makeFixture({ answers: JSON.stringify(envelope) });

    const res = runCli([briefPath]);
    assert.equal(res.status, 1, 'partial apply must exit 1');
    assert.equal(fs.existsSync(answersPath), true, 'answers file must survive a partial apply');

    const summary = JSON.parse(res.stdout);
    assert.equal(summary.deletedAnswersFile, false);
    const skippedKeys = summary.skipped.map((s) => s.key);
    assert.ok(skippedKeys.includes('A question the brief does not contain?'));
    // The applicable answer still persisted — partial apply is not all-or-nothing.
    assert.match(fs.readFileSync(briefPath, 'utf8'), /\*\*Resolution:\*\* Use SQS\./);
  });

  it('is idempotent end-to-end: re-running with already-recorded keys exits 0 and consumes the file', () => {
    const envelope = { openQuestions: { [OPEN_Q]: 'Use SQS.' } };
    const { briefPath, answersPath } = makeFixture({ answers: JSON.stringify(envelope) });
    assert.equal(runCli([briefPath]).status, 0);

    // Simulate a crash-recovery re-run with the same answers file re-written.
    fs.writeFileSync(answersPath, JSON.stringify(envelope), 'utf8');
    const res = runCli([briefPath]);
    assert.equal(res.status, 0, 'already-recorded keys count as success');
    assert.equal(fs.existsSync(answersPath), false, 'file must still be consumed');
  });

  it('exits 1 on malformed JSON and leaves brief.md and the answers file untouched', () => {
    const { briefPath, answersPath } = makeFixture({ answers: '{not json' });
    const before = fs.readFileSync(briefPath, 'utf8');

    const res = runCli([briefPath]);
    assert.equal(res.status, 1);
    assert.equal(fs.readFileSync(briefPath, 'utf8'), before, 'brief.md must be untouched');
    assert.equal(fs.existsSync(answersPath), true, 'malformed file must be kept for inspection');
  });

  it('exits 1 when the answers file is missing', () => {
    const { briefPath } = makeFixture();
    const res = runCli([briefPath]);
    assert.equal(res.status, 1);
  });

  it('exits 1 with usage when briefPath is missing', () => {
    const res = runCli([]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Usage/i);
  });

  it('exits 1 and keeps the answers file when the step guard refuses (spec in_progress)', () => {
    const envelope = { openQuestions: { [OPEN_Q]: 'Use SQS.' } };
    const { dir, briefPath, answersPath } = makeFixture({ answers: JSON.stringify(envelope) });
    fs.writeFileSync(
      path.join(dir, '.work-state.json'),
      JSON.stringify({ stepStatus: { brief_gate: 'completed', spec: 'in_progress' } }),
      'utf8'
    );
    const before = fs.readFileSync(briefPath, 'utf8');

    const res = runCli([briefPath]);
    assert.equal(res.status, 1);
    assert.equal(fs.readFileSync(briefPath, 'utf8'), before);
    assert.equal(fs.existsSync(answersPath), true);
    const summary = JSON.parse(res.stdout);
    assert.equal(summary.refused, 'step');
  });
});

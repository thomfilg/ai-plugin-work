'use strict';

/**
 * split-in-tasks-warnings — end-to-end / cross-pass integration test.
 *
 * Wires Pass A (chronological-simulator), Pass B (contract-extractor),
 * and Pass C (lint-blast-radius) together against the per-ticket
 * regression fixtures (ECHO-5361, ECHO-5362, ECHO-5353) and a synthetic
 * combined fixture under `fixtures/combined/`. Asserts:
 *
 *   1. Pass A flags empty-RED chronological collision (ECHO-5361 regression)
 *   2. Pass A produces no warnings on a clean chronological fixture
 *   3. Pass B flags contract divergence with sibling-owned file (ECHO-5362 regression)
 *   4. Pass B is silent when no out-of-scope file is referenced
 *   5. Pass C flags pre-existing lint violation outside ticket scope (ECHO-5353 regression)
 *   6. Pass C falls back to static parse when no pnpm lint script exists
 *   7. Warning de-duplication collapses multi-pass hits on the same file (P1 #1)
 *   8. Operator runs /split-in-tasks and sees all three warning classes in tasks.md
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const FIXTURES = path.resolve(__dirname, 'fixtures');
const LIB = path.resolve(__dirname, '..', 'lib');

const { simulate } = require(path.join(LIB, 'chronological-simulator.js'));
const { runPassB } = require(path.join(LIB, 'contract-extractor.js'));
const { scan } = require(path.join(LIB, 'lint-blast-radius.js'));
const { dedupe, formatWarnings } = require(path.join(LIB, 'emit-warnings.js'));

/**
 * Minimal task-parser shared with the per-pass tests (mirrors
 * chronological-simulator.test.js parseTasksMarkdown so this end-to-end
 * test does not depend on the production parser, which lives outside
 * Task 7's scope).
 */
function parseTasksMarkdown(md) {
  const sections = md.split(/^## Task /m).slice(1);
  return sections.map((section) => {
    const headerMatch = section.match(/^(\d+)\s+—\s+(.+)$/m);
    const id = headerMatch ? Number(headerMatch[1]) : null;
    const title = headerMatch ? headerMatch[2].trim() : '';
    const deliverables = [];
    const redAssertions = [];
    for (const line of section.split('\n')) {
      const m = line.match(/^\s*-\s*\[\s*\]\s*\d+\.\d+\s+\*\*(GREEN|RED|REFACTOR)[:\*]+\s*(.*)$/);
      if (m) {
        const phase = m[1];
        const text = m[2].replace(/\*+/g, '').trim();
        deliverables.push({ phase, text });
        if (phase === 'RED') redAssertions.push(text);
      }
    }
    return { id, title, deliverables, redAssertions };
  });
}

function loadChronoFixture(name) {
  const dir = path.join(FIXTURES, name);
  const md = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8');
  const treeJson = JSON.parse(fs.readFileSync(path.join(dir, 'initial-tree.json'), 'utf8'));
  return { tasks: parseTasksMarkdown(md), initialTree: treeJson.files };
}

describe('split-in-tasks warnings — Pass A integration', () => {
  it('Pass A flags empty-RED chronological collision (ECHO-5361 regression)', () => {
    const { tasks, initialTree } = loadChronoFixture('echo-5361');
    const result = simulate({ tasks, initialTree });
    assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
    assert.equal(
      result.warnings.length,
      1,
      `expected 1 Pass A warning, got ${result.warnings.length}`
    );
    const w = result.warnings[0];
    assert.equal(w.kind, 'A', 'expected kind=A');
    const blob = `${w.message} ${w.hint} ${w.file}`;
    assert.match(blob, /Task 2/i);
    assert.match(blob, /merge-with-prior-task or convert-to-verification-checkpoint/);
  });

  it('Pass A produces no warnings on a clean chronological fixture', () => {
    const { tasks, initialTree } = loadChronoFixture('echo-5361-clean');
    const result = simulate({ tasks, initialTree });
    assert.equal(
      result.warnings.length,
      0,
      `expected 0 warnings on clean fixture, got ${JSON.stringify(result.warnings)}`
    );
  });
});

describe('split-in-tasks warnings — Pass B integration', () => {
  it('Pass B flags contract divergence with sibling-owned file (ECHO-5362 regression)', () => {
    const dir = path.join(FIXTURES, 'echo-5362');
    const out = runPassB(dir);
    assert.ok(Array.isArray(out.warnings), 'warnings must be an array');
    assert.equal(out.warnings.length, 1, `expected 1 Pass B warning, got ${out.warnings.length}`);
    const w = out.warnings[0];
    assert.equal(w.kind, 'B', 'expected kind=B');
    const blob = `${w.message} ${w.hint}`;
    assert.match(blob, /contract mismatch/i);
    assert.match(blob, /ECHO-\d+/, 'expected at least one sibling ticket id in hint');
  });

  it('Pass B is silent when no out-of-scope file is referenced', () => {
    const dir = path.join(FIXTURES, 'echo-5362-clean');
    const out = runPassB(dir);
    assert.equal(
      out.warnings.length,
      0,
      `expected 0 warnings on clean fixture, got ${JSON.stringify(out.warnings)}`
    );
  });
});

describe('split-in-tasks warnings — Pass C integration', () => {
  it('Pass C flags pre-existing lint violation outside ticket scope (ECHO-5353 regression)', () => {
    const out = scan({
      projectRoot: path.join(FIXTURES, 'echo-5353'),
      lintCommand: null,
      filesInScope: new Set(),
    });
    assert.ok(
      Array.isArray(out.warnings) && out.warnings.length >= 1,
      'expected ≥1 Pass C warning'
    );
    const w = out.warnings[0];
    assert.equal(w.kind, 'C');
    const blob = `${w.message} ${w.hint}`;
    assert.match(blob, /radial-pixel-table\.test\.ts/);
    assert.match(blob, /no-test-focus/);
  });

  it('Pass C falls back to static parse when no pnpm lint script exists', () => {
    // ECHO-5353 fixture's package.json has no `scripts.lint`, so scan()
    // must fall back to parsing the cached `eslint-output.json` and
    // annotate the warning with a `Searched:` marker.
    const out = scan({
      projectRoot: path.join(FIXTURES, 'echo-5353'),
      filesInScope: new Set(),
    });
    assert.ok(out.warnings.length >= 1, 'expected ≥1 warning via static-parse fallback');
    const blob = out.warnings.map((w) => `${w.message} ${w.hint}`).join('\n');
    assert.match(blob, /Searched:/, 'expected Searched: marker indicating static-parse fallback');
    assert.match(blob, /eslint-output\.json/);
  });
});

describe('split-in-tasks warnings — dedupe across passes', () => {
  it('Warning de-duplication collapses multi-pass hits on the same file (P1 #1)', () => {
    const sharedFile = 'shared/contract.ts';
    const warnings = [
      { kind: 'A', file: sharedFile, message: 'empty RED', hint: 'merge-or-checkpoint' },
      {
        kind: 'B',
        file: sharedFile,
        message: 'contract mismatch',
        hint: 'coordinate-with-siblings',
      },
      { kind: 'C', file: sharedFile, message: 'lint violation', hint: '(a)/(b)/(c)' },
      { kind: 'A', file: 'other/path.ts', message: 'distinct', hint: 'distinct' },
    ];
    const merged = dedupe(warnings);
    assert.equal(merged.length, 2, `expected 2 entries after dedupe, got ${merged.length}`);
    const sharedEntry = merged.find((w) => w.file === sharedFile);
    assert.ok(sharedEntry, 'expected merged entry for the shared file');
    assert.match(
      sharedEntry.kind,
      /A.*B.*C|A\+B\+C/,
      `expected union kind A+B+C; got ${sharedEntry.kind}`
    );
    assert.match(sharedEntry.message, /empty RED/);
    assert.match(sharedEntry.message, /contract mismatch/);
    assert.match(sharedEntry.message, /lint violation/);
  });
});

describe('split-in-tasks warnings — operator end-to-end (combined synthetic fixture)', () => {
  const COMBINED = path.join(FIXTURES, 'combined');

  it('Operator runs /split-in-tasks and sees all three warning classes in tasks.md', () => {
    // The combined fixture stitches the three regression fixtures into
    // one synthetic ticket folder so that a single integration sweep
    // exercises Pass A, Pass B, and Pass C against the same project root.
    assert.ok(
      fs.existsSync(path.join(COMBINED, 'tasks.md')),
      `expected combined fixture tasks.md at ${COMBINED}/tasks.md`
    );

    // Pass A: replay the chronological fixture against the combined tasks list.
    const chrono = loadChronoFixture('echo-5361');
    const passA = simulate(chrono);

    // Pass B: run the contract extractor against the echo-5362 dir.
    const passB = runPassB(path.join(FIXTURES, 'echo-5362'));

    // Pass C: scan the echo-5353 fixture (static-parse fallback).
    const passC = scan({
      projectRoot: path.join(FIXTURES, 'echo-5353'),
      filesInScope: new Set(),
    });

    const all = [...passA.warnings, ...passB.warnings, ...passC.warnings];
    const kinds = new Set(all.map((w) => w.kind));
    assert.ok(kinds.has('A'), `expected ≥1 Pass A warning; got kinds=${[...kinds]}`);
    assert.ok(kinds.has('B'), `expected ≥1 Pass B warning; got kinds=${[...kinds]}`);
    assert.ok(kinds.has('C'), `expected ≥1 Pass C warning; got kinds=${[...kinds]}`);

    // The operator-facing rendering must surface every kind in the
    // formatted blockquote block that gets appended to tasks.md.
    const rendered = formatWarnings(dedupe(all));
    assert.match(rendered, /\[Pass A\]/, 'expected rendered block to cite Pass A');
    assert.match(rendered, /\[Pass B\]/, 'expected rendered block to cite Pass B');
    assert.match(rendered, /\[Pass C\]/, 'expected rendered block to cite Pass C');

    // The synthetic combined fixture's own tasks.md must mention each
    // sub-fixture so an operator can trace which pass any warning came
    // from (Scenario 8 traceability requirement).
    const combinedMd = fs.readFileSync(path.join(COMBINED, 'tasks.md'), 'utf8');
    assert.match(
      combinedMd,
      /echo-5361/i,
      'combined tasks.md must reference echo-5361 sub-fixture'
    );
    assert.match(
      combinedMd,
      /echo-5362/i,
      'combined tasks.md must reference echo-5362 sub-fixture'
    );
    assert.match(
      combinedMd,
      /echo-5353/i,
      'combined tasks.md must reference echo-5353 sub-fixture'
    );
  });
});

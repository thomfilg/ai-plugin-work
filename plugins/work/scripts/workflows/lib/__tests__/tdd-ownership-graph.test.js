'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildCoverageGraph, findOrphanedPaths } = require('../tdd-ownership-graph');

/**
 * Build a minimal task object understood by the graph module.
 * Mirrors the relevant subset of `parseTasks` output shape.
 */
function mkTask({ num, heading, filesInScope, testStrategy }) {
  return {
    num,
    heading: heading || `Task ${num}`,
    filesInScope: filesInScope || [],
    testStrategy: testStrategy || null,
  };
}

test('buildCoverageGraph keys every path listed in any Files in scope', () => {
  const tasks = [
    mkTask({
      num: 1,
      filesInScope: ['src/a.ts', 'src/a.test.ts'],
      testStrategy: { kind: 'unit', entry: 'src/a.test.ts' },
    }),
    mkTask({
      num: 2,
      filesInScope: ['src/b.ts'],
      testStrategy: { kind: 'wiring-citation', verifiedBy: 'Task 1' },
    }),
  ];
  const graph = buildCoverageGraph(tasks);
  assert.ok(graph instanceof Map);
  assert.ok(graph.has('src/a.ts'));
  assert.ok(graph.has('src/a.test.ts'));
  assert.ok(graph.has('src/b.ts'));
  // Task 1 covers its own paths via its unit entry transitively touching src/a.ts.
  assert.ok(graph.get('src/a.ts') instanceof Set);
});

test('covered-by-peer-entry: peer task entry transitively touches path → no orphan', () => {
  // Task 2 owns tasks.ts; Task 1 has a unit test entry whose path matches tasks.ts scope.
  const tasks = [
    mkTask({
      num: 1,
      filesInScope: ['src/tasks.ts', 'src/__tests__/tasks.test.ts'],
      testStrategy: { kind: 'unit', entry: 'src/__tests__/tasks.test.ts' },
    }),
    mkTask({
      num: 2,
      filesInScope: ['src/tasks.ts'],
      testStrategy: { kind: 'wiring-citation', verifiedBy: 'Task 1' },
    }),
  ];
  const graph = buildCoverageGraph(tasks);
  const orphans = findOrphanedPaths(tasks, graph);
  // tasks.ts is covered because Task 1 owns it as well; no orphan.
  const paths = orphans.map((o) => o.path);
  assert.ok(!paths.includes('src/tasks.ts'));
});

test('owned-but-uncovered (AC15): Task 2 owns tasks.ts, no peer entry → orphan with 3-option remediation', () => {
  const tasks = [
    mkTask({
      num: 1,
      filesInScope: ['src/a.ts', 'src/__tests__/a.test.ts'],
      testStrategy: { kind: 'unit', entry: 'src/__tests__/a.test.ts' },
    }),
    mkTask({
      num: 2,
      heading: 'Task 2 — orphan owner',
      filesInScope: ['src/tasks.ts'],
      testStrategy: null, // no strategy at all
    }),
  ];
  const graph = buildCoverageGraph(tasks);
  const orphans = findOrphanedPaths(tasks, graph);
  const orphan = orphans.find((o) => o.path === 'src/tasks.ts');
  assert.ok(orphan, 'expected src/tasks.ts to be reported as orphaned');
  assert.equal(orphan.owner, 2);
  assert.ok(Array.isArray(orphan.remediation));
  assert.equal(orphan.remediation.length, 3);
  const joined = orphan.remediation.join('\n');
  assert.match(joined, /fold into peer/i);
  assert.match(joined, /wiring-citation/i);
  assert.match(joined, /add (?:a )?test entry/i);
});

test('docs-only path without wiring-citation → orphan diagnostic', () => {
  const tasks = [
    mkTask({
      num: 1,
      filesInScope: ['docs/foo.md', 'docs/bar.md'],
      testStrategy: { kind: 'unit', entry: 'src/__tests__/x.test.js' },
    }),
  ];
  const graph = buildCoverageGraph(tasks);
  const orphans = findOrphanedPaths(tasks, graph);
  // Docs-only task didn't declare wiring-citation/verified-by → must be flagged.
  assert.ok(
    orphans.some((o) => o.path === 'docs/foo.md' || o.path === 'docs/bar.md'),
    'expected docs-only task without wiring-citation to surface a diagnostic'
  );
});

test('docs-only path WITH wiring-citation → no orphan', () => {
  const tasks = [
    mkTask({
      num: 1,
      filesInScope: ['src/a.ts', 'src/__tests__/a.test.ts'],
      testStrategy: { kind: 'unit', entry: 'src/__tests__/a.test.ts' },
    }),
    mkTask({
      num: 2,
      filesInScope: ['docs/foo.md'],
      testStrategy: { kind: 'wiring-citation', verifiedBy: 'Task 1' },
    }),
  ];
  const graph = buildCoverageGraph(tasks);
  const orphans = findOrphanedPaths(tasks, graph);
  assert.ok(!orphans.some((o) => o.path === 'docs/foo.md'));
});

const { describe: d3, it: i3 } = require('node:test');
const assertEq3 = require('node:assert/strict');
const graph = require('../tdd-ownership-graph');

d3('e2e kind covers its scope (cursor[bot] 3385241040)', () => {
  i3('Task with kind=e2e + entry covers its in-scope path; no orphan reported', () => {
    const tasks = [
      {
        num: 1,
        filesInScope: ['app/page.tsx', 'tests/e2e/page.spec.ts'],
        testStrategy: { kind: 'e2e', entry: 'tests/e2e/page.spec.ts' },
      },
    ];
    const coverage = graph.buildCoverageGraph(tasks);
    const orphans = graph.findOrphanedPaths(tasks, coverage);
    assertEq3.equal(orphans.length, 0, `expected zero orphans, got: ${JSON.stringify(orphans)}`);
  });
});

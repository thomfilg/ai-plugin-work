'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const MODULE_PATH = path.resolve(__dirname, '..', 'lib', 'chronological-simulator.js');
const FIXTURES = path.resolve(__dirname, 'fixtures');

/**
 * Minimal task-parser sufficient for the simulator tests. The simulator
 * itself does not depend on this — it consumes the parsed shape:
 *   { id, title, deliverables: string[], redAssertions: string[] }
 */
function parseTasksMarkdown(md) {
  const sections = md.split(/^## Task /m).slice(1);
  return sections.map((section) => {
    const headerMatch = section.match(/^(\d+)\s+—\s+(.+)$/m);
    const id = headerMatch ? Number(headerMatch[1]) : null;
    const title = headerMatch ? headerMatch[2].trim() : '';
    const deliverables = [];
    const redAssertions = [];
    const lines = section.split('\n');
    for (const line of lines) {
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

function loadFixture(name) {
  const dir = path.join(FIXTURES, name);
  const md = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8');
  const treeJson = JSON.parse(fs.readFileSync(path.join(dir, 'initial-tree.json'), 'utf8'));
  return {
    tasks: parseTasksMarkdown(md),
    initialTree: treeJson.files,
  };
}

describe('chronological-simulator — Pass A', () => {
  describe('mutation parser / projected tree', () => {
    it('projected tree after Task 1 omits surfaces/foo.ts in echo-5361 fixture (delete verb)', () => {
      const { simulate } = require(MODULE_PATH);
      const { tasks, initialTree } = loadFixture('echo-5361');
      const result = simulate({ tasks, initialTree });
      const projected = result.projectedTreeAfter(1);
      assert.ok(Array.isArray(projected), 'projectedTreeAfter must return an array');
      assert.ok(
        !projected.includes('surfaces/foo.ts'),
        `projected tree after Task 1 must omit surfaces/foo.ts; got: ${JSON.stringify(projected)}`
      );
      assert.ok(
        projected.includes('surfaces/bar.ts'),
        `projected tree after Task 1 must retain surfaces/bar.ts; got: ${JSON.stringify(projected)}`
      );
    });

    it('recognises additive verbs (create/add/introduce/new file) and adds files to projected tree', () => {
      const { simulate } = require(MODULE_PATH);
      const tasks = [
        {
          id: 1,
          title: 'Add new module',
          deliverables: [{ phase: 'GREEN', text: 'create surfaces/new-thing.ts with the export' }],
          redAssertions: [],
        },
      ];
      const result = simulate({ tasks, initialTree: ['package.json'] });
      const projected = result.projectedTreeAfter(1);
      assert.ok(
        projected.includes('surfaces/new-thing.ts'),
        `projected tree must include newly created file; got: ${JSON.stringify(projected)}`
      );
    });
  });

  describe('warning emission (AC1 / AC2)', () => {
    it('echo-5361 fixture emits exactly one warning naming Task 2 with the merge/checkpoint hint', () => {
      const { simulate } = require(MODULE_PATH);
      const { tasks, initialTree } = loadFixture('echo-5361');
      const result = simulate({ tasks, initialTree });
      assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
      assert.equal(
        result.warnings.length,
        1,
        `expected exactly 1 warning, got ${result.warnings.length}: ${JSON.stringify(result.warnings)}`
      );
      const w = result.warnings[0];
      const blob = `${w.message || ''} ${w.hint || ''} ${w.file || ''}`;
      assert.match(blob, /Task 2/i, `warning must reference Task 2; got: ${JSON.stringify(w)}`);
      assert.match(
        blob,
        /merge-with-prior-task or convert-to-verification-checkpoint/,
        `warning must include the merge/checkpoint hint; got: ${JSON.stringify(w)}`
      );
    });

    it('echo-5361-clean fixture emits zero warnings', () => {
      const { simulate } = require(MODULE_PATH);
      const { tasks, initialTree } = loadFixture('echo-5361-clean');
      const result = simulate({ tasks, initialTree });
      assert.equal(
        result.warnings.length,
        0,
        `expected zero warnings, got ${result.warnings.length}: ${JSON.stringify(result.warnings)}`
      );
    });

    it('formatted warning rendering goes through emit-warnings (formatWarnings)', () => {
      const { simulate } = require(MODULE_PATH);
      const { formatWarnings } = require(path.resolve(__dirname, '..', 'lib', 'emit-warnings.js'));
      const { tasks, initialTree } = loadFixture('echo-5361');
      const result = simulate({ tasks, initialTree });
      const rendered = formatWarnings(result.warnings);
      assert.match(rendered, /^> ⚠️ SPLIT-WARNING:/m, 'rendered output must use SPLIT-WARNING blockquote');
      assert.match(rendered, /Pass A/, 'rendered output must cite Pass A');
    });
  });

  describe('purity (R13/R14)', () => {
    it('module source contains no console.* / process.exit calls', () => {
      const src = fs.readFileSync(MODULE_PATH, 'utf8');
      assert.ok(!/console\.[a-z]+\s*\(/.test(src), 'module must not call console.*');
      assert.ok(!/process\.exit\s*\(/.test(src), 'module must not call process.exit');
    });
  });
});

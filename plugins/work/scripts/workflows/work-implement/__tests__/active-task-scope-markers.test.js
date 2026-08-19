'use strict';

/**
 * `### Files in scope` bullets legitimately carry the documented `(NEW)` /
 * `(DELETE)` markers — `scope_exists` REQUIRES the annotation on a path that is
 * not on disk yet. The scope parser must strip it, or every downstream gate
 * receives a path ending in " (NEW)" that can never resolve, making its
 * conditions unsatisfiable regardless of whether the work is sound.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readActiveTaskBlock } = require('../tdd-phase-state/active-task');

const TASKS_MD = [
  '# Tasks',
  '',
  '## Task 1 — Add the sparkline',
  '',
  '### Type',
  'tdd-code',
  '',
  '### Files in scope',
  '- `components/ui/sparkline/**` (NEW)',
  '- `components/ui/sparkline/sparkline.test.tsx` (new)',
  '- `lib/legacy/old-helper.ts` (DELETE)',
  '- `components/shell/sidebar/sidebar.tsx`',
  '- `lib/home/hash-routing.ts` # owned by a sibling',
  '',
  '## Task 2 — Something else',
  '',
].join('\n');

describe('readActiveTaskBlock strips scope markers', () => {
  let root;
  let prevBase;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-task-scope-'));
    fs.mkdirSync(path.join(root, 'ECHO-9999'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ECHO-9999', 'tasks.md'), TASKS_MD);
    prevBase = process.env.TASKS_BASE;
    process.env.TASKS_BASE = root;
  });

  after(() => {
    if (prevBase === undefined) delete process.env.TASKS_BASE;
    else process.env.TASKS_BASE = prevBase;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns paths with no (NEW)/(DELETE) annotation left attached', () => {
    const { scope } = readActiveTaskBlock('ECHO-9999', 1);
    assert.deepEqual(scope, [
      'components/ui/sparkline/**',
      'components/ui/sparkline/sparkline.test.tsx',
      'lib/legacy/old-helper.ts',
      'components/shell/sidebar/sidebar.tsx',
      'lib/home/hash-routing.ts',
    ]);
  });

  it('leaves no entry that could never resolve on disk', () => {
    const { scope } = readActiveTaskBlock('ECHO-9999', 1);
    for (const entry of scope) {
      assert.doesNotMatch(entry, /\((?:NEW|DELETE)\)/i, `"${entry}" still carries its marker`);
    }
  });
});

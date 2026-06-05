'use strict';

/**
 * Bug 2 regression guard:
 *   readReuseAudit() must attach a per-entry `requirementId` (synthesized as
 *   `REUSE-<n>`), and reuse_audit_enforcement must use it on failure records
 *   rather than the previously hard-pinned 'R1'.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shared = require('../lib/kind-checks/shared');
const phase = require('../lib/phases/reuse_audit_enforcement');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh282-reuse-reqid-'));
}

function writeSpec(dir, body) {
  fs.writeFileSync(path.join(dir, 'spec.md'), body, 'utf8');
}

test('readReuseAudit synthesizes REUSE-<n> ids for each entry', () => {
  const dir = mkTmp();
  try {
    writeSpec(
      dir,
      [
        '# Spec',
        '',
        '## Reuse Audit',
        '',
        '- `Foo` MUST be reused from `a.ts`',
        '- `Bar` MUST be reused from `b.ts`',
        '- `Baz` may be reused from `c.ts`',
        '',
      ].join('\n'),
    );
    const result = shared.readReuseAudit(dir);
    assert.equal(result.length, 3);
    assert.equal(result[0].requirementId, 'REUSE-1');
    assert.equal(result[1].requirementId, 'REUSE-2');
    assert.equal(result[2].requirementId, 'REUSE-3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failure record carries the synthesized REUSE-<n> id, not the legacy R1 default', async () => {
  const root = mkTmp();
  try {
    const tasksDir = path.join(root, 'tasks', 'GH-282');
    fs.mkdirSync(tasksDir, { recursive: true });
    writeSpec(
      tasksDir,
      [
        '# Spec',
        '',
        '## Reuse Audit',
        '',
        '- `AlphaWidget` MUST be reused from `a.ts`',
        '- `BetaWidget` MUST be reused from `b.ts`',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tasksDir, 'pr-context.json'),
      JSON.stringify({ files: ['x.ts'] }, null, 2),
    );
    fs.writeFileSync(path.join(root, 'x.ts'), 'export const z = 1;\n');
    const ctx = { tasksDir, worktreeRoot: root, failures: [] };
    await phase.validate(ctx);
    const records = ctx.failures.filter((f) => f.checkType === 'reuse_audit');
    assert.equal(records.length, 2);
    const ids = records.map((r) => r.requirementId).sort();
    assert.deepEqual(ids, ['REUSE-1', 'REUSE-2']);
    assert.ok(!records.some((r) => r.requirementId === 'R1'), 'legacy R1 must be gone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

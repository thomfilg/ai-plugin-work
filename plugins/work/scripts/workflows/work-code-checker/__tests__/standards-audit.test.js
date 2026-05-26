'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const standardsAudit = require('../lib/phases/standards_audit');

function makeWorktree({ files = {}, prContext = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standards-'));
  const worktreeRoot = path.join(root, 'wt');
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const tasksDir = path.join(root, 'tasks', 'ECHO-7777');
  fs.mkdirSync(tasksDir, { recursive: true });
  if (prContext)
    fs.writeFileSync(path.join(tasksDir, 'pr-context.json'), JSON.stringify(prContext));
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(worktreeRoot, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  return { root, tasksDir, worktreeRoot };
}

test('BLOCKS on `as any` in diff', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    files: { 'src/foo.ts': 'const x = JSON.parse(s) as any;\n' },
    prContext: { base: 'origin/main', files: ['src/foo.ts'] },
  });
  const r = standardsAudit.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('as any') || r.errors[0].includes('Critical'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('BLOCKS on @ts-ignore', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    files: { 'src/foo.ts': '// @ts-ignore\nconst x = 1;\n' },
    prContext: { base: 'origin/main', files: ['src/foo.ts'] },
  });
  const r = standardsAudit.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('passes when no critical TS violations', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    files: { 'src/foo.ts': 'const x: number = 1;\nexport { x };\n' },
    prContext: { base: 'origin/main', files: ['src/foo.ts'] },
  });
  const r = standardsAudit.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('warns (does not block) on bare `: any` annotation', () => {
  const { root, tasksDir, worktreeRoot } = makeWorktree({
    files: { 'src/foo.ts': 'function f(x: any) { return x; }\n' },
    prContext: { base: 'origin/main', files: ['src/foo.ts'] },
  });
  const r = standardsAudit.validate({ tasksDir, worktreeRoot });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  assert.ok(r.warnings && r.warnings.length > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

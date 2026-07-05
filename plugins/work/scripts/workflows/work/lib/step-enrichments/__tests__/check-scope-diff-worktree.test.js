/**
 * Regression tests for the "scope-diff computed against the wrong repo/base"
 * bug family (ECHO-5148/5719/5807/5816/5818/5821, ECHO-5325).
 *
 * The check step's Gate E scope-diff used to run `git diff` with
 * cwd = ctx.workDir — the work-workflow PLUGIN's own checkout — so the
 * "unaccounted" list contained hundreds of plugins/work/... files that do
 * not exist in the ticket worktree. It must instead:
 *
 *   1. Run `git -C <worktreeDir> diff --name-only origin/<base>...HEAD`
 *      where worktreeDir is the ticket worktree from the orchestrator state.
 *   2. Count only the COMMITTED branch diff — untracked working-tree files
 *      (editor backups, logs) are never "unaccounted" (ECHO-5325).
 *   3. When the worktree can't be resolved or git fails, produce a
 *      "scope-diff unavailable: <reason>" block instead of silently
 *      diffing whatever repo the orchestrator happens to run from.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const registerCheck = require('../check');
const { gitDiffFiles, buildScopeDiffBlock } = registerCheck;

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-scope-diff-'));
});

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/**
 * Build a real "app" repo with an origin remote:
 *   origin/main has base.txt; the ticket branch adds two committed files
 *   plus one UNTRACKED working-tree artifact.
 */
function makeAppWorktree() {
  const origin = path.join(tmpRoot, 'origin.git');
  const worktree = path.join(tmpRoot, 'app-worktree');
  fs.mkdirSync(origin, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { encoding: 'utf8' });
  execFileSync('git', ['clone', origin, worktree], { encoding: 'utf8', stdio: 'pipe' });
  git(worktree, 'config', 'user.email', 'test@example.com');
  git(worktree, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(worktree, 'base.txt'), 'base\n');
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-m', 'base');
  git(worktree, 'push', 'origin', 'main');
  // Ticket branch with two committed files
  git(worktree, 'checkout', '-b', 'feature/TICKET-1');
  fs.writeFileSync(path.join(worktree, 'in-scope.ts'), 'export {};\n');
  fs.writeFileSync(path.join(worktree, 'surprise.ts'), 'export {};\n');
  git(worktree, 'add', 'in-scope.ts', 'surprise.ts');
  git(worktree, 'commit', '-m', 'feature');
  // Untracked local artifact — must NEVER appear as unaccounted (ECHO-5325)
  fs.writeFileSync(path.join(worktree, '.claude.json.backup.123'), '{}\n');
  return worktree;
}

function makeTasksDir(scopeFile) {
  const tasksDir = path.join(tmpRoot, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(tasksDir, 'tasks.md'),
    `# Task Plan

## Task 1 — Feature

### Type
feature

### Description
Test task.

### Files in scope
- ${scopeFile}

### Acceptance Criteria
- AC1

### Dependencies
- None
`,
    'utf8'
  );
  return tasksDir;
}

describe('gitDiffFiles — worktree-scoped committed diff', () => {
  it('diffs the WORKTREE (not process.cwd()) against origin/<base>...HEAD, excluding untracked files', () => {
    const worktree = makeAppWorktree();
    // process.cwd() here is the plugin repo — the bug was diffing it instead.
    const result = gitDiffFiles(worktree);
    assert.ok(result.files, `expected files, got reason: ${result.reason}`);
    assert.deepEqual(result.files.sort(), ['in-scope.ts', 'surprise.ts']);
    // Untracked artifact excluded (committed diff only)
    assert.ok(!result.files.includes('.claude.json.backup.123'));
    // No plugin-repo files leaked in
    assert.ok(!result.files.some((f) => f.startsWith('plugins/') || f.startsWith('factories/')));
  });

  it('invokes git with -C <worktree> and a <ref>...HEAD triple-dot committed diff (never git status)', () => {
    const calls = [];
    const fakeExec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return 'a.ts\n';
    };
    const result = gitDiffFiles('/fake/worktree', fakeExec);
    assert.deepEqual(result.files, ['a.ts']);
    assert.equal(calls.length, 1);
    const [cmd, ...args] = calls[0];
    assert.equal(cmd, 'git');
    assert.deepEqual(args.slice(0, 2), ['-C', '/fake/worktree']);
    assert.equal(args[2], 'diff');
    assert.equal(args[3], '--name-only');
    assert.match(args[4], /^origin\/[^.]+\.\.\.HEAD$/);
    // Never inspects working-tree / untracked state
    assert.ok(!args.includes('status'));
    assert.ok(!args.some((a) => String(a).includes('--others')));
  });

  it('returns a reason (not a wrong-repo diff) when every base candidate fails', () => {
    const fakeExec = () => {
      throw new Error('fatal: ambiguous argument');
    };
    const result = gitDiffFiles('/fake/worktree', fakeExec);
    assert.equal(result.files, null);
    assert.match(result.reason, /git diff failed in \/fake\/worktree/);
  });
});

describe('buildScopeDiffBlock — Gate E block construction', () => {
  it('produces a summary from the worktree branch diff; untracked files are not unaccounted', () => {
    const worktree = makeAppWorktree();
    const tasksDir = makeTasksDir('in-scope.ts');
    const block = buildScopeDiffBlock(tasksDir, worktree);
    assert.ok(block);
    assert.equal(block.kind, 'summary');
    assert.match(block.text, /Scope-diff summary/);
    assert.match(block.text, /surprise\.ts/); // committed, undeclared → unaccounted
    assert.ok(
      !block.text.includes('.claude.json.backup.123'),
      'untracked file leaked into summary'
    );
  });

  it('reports "unavailable" when the worktree path is missing', () => {
    const tasksDir = makeTasksDir('in-scope.ts');
    const block = buildScopeDiffBlock(tasksDir, undefined);
    assert.equal(block.kind, 'unavailable');
    assert.match(block.reason, /could not be resolved/);
  });

  it('reports "unavailable" when the worktree directory does not exist', () => {
    const tasksDir = makeTasksDir('in-scope.ts');
    const missing = path.join(tmpRoot, 'no-such-worktree');
    const block = buildScopeDiffBlock(tasksDir, missing);
    assert.equal(block.kind, 'unavailable');
    assert.match(block.reason, /worktree directory not found/);
    assert.ok(block.reason.includes(missing));
  });

  it('reports "unavailable" when git fails inside a resolvable worktree', () => {
    const tasksDir = makeTasksDir('in-scope.ts');
    const worktree = path.join(tmpRoot, 'not-a-repo');
    fs.mkdirSync(worktree, { recursive: true });
    const failingExec = () => {
      throw new Error('fatal: not a git repository');
    };
    const block = buildScopeDiffBlock(tasksDir, worktree, { exec: failingExec });
    assert.equal(block.kind, 'unavailable');
    assert.match(block.reason, /git diff failed/);
  });
});

describe('registerCheck — check2 delegate prompt', () => {
  function runEnrichment(ctx) {
    let fn;
    registerCheck((step, f) => {
      if (step === 'check') fn = f;
    });
    const entry = { step: 'check' };
    fn(entry, ctx);
    return entry;
  }

  it('appends the worktree-scoped summary + Gate E instruction when a diff exists', () => {
    const worktree = makeAppWorktree();
    const tasksDir = makeTasksDir('in-scope.ts');
    const entry = runEnrichment({ ticket: 'TICKET-1', tasksDir, worktreeDir: worktree });
    assert.match(entry.agentPrompt, /^\/work-workflow:check2 TICKET-1/);
    assert.match(entry.agentPrompt, /Scope-diff summary/);
    assert.match(entry.agentPrompt, /Gate E/);
    assert.ok(!entry.agentPrompt.includes('.claude.json.backup.123'));
  });

  it('says "scope-diff unavailable" — never a wrong-repo file list — when worktreeDir is unresolvable', () => {
    const tasksDir = makeTasksDir('in-scope.ts');
    // ctx.workDir points at the plugin checkout (the old buggy diff target);
    // it must NOT be used as a fallback.
    const entry = runEnrichment({
      ticket: 'TICKET-1',
      tasksDir,
      workDir: path.join(__dirname, '..', '..', '..'),
      worktreeDir: undefined,
    });
    assert.match(entry.agentPrompt, /scope-diff unavailable: /);
    assert.ok(
      !entry.agentPrompt.includes('unaccounted:'),
      'must not emit counts from the wrong repo'
    );
    assert.ok(!/plugins\/work\//.test(entry.agentPrompt.replace('/work-workflow:check2', '')));
  });
});

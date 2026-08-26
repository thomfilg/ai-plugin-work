'use strict';

/**
 * Tests for lib/workflow-artifact-diff.js — the shared "did the CODE change?"
 * predicate that breaks the /check self-invalidation livelock.
 *
 * Two properties matter, and they pull in opposite directions:
 *   - workflow artifacts must NOT register as change (else a passing check
 *     invalidates itself the moment its reports are committed)
 *   - a real source change must ALWAYS register (else a stale approval stands)
 *
 * Run with: node --test workflows/lib/__tests__/workflow-artifact-diff.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const artifactDiff = require('../workflow-artifact-diff');

const {
  codeRelevantChangedFiles,
  codeRelevantDiff,
  hasCodeRelevantChanges,
  isRealHeadDrift,
  isWorkflowArtifactPath,
  tasksBaseRelative,
} = artifactDiff;

describe('isWorkflowArtifactPath — rule 2 (unambiguous basenames, any depth)', () => {
  const artifacts = [
    'tests.check.md',
    'code-review.check.md',
    'completion.check.md',
    'tasks/GH-1/qa-feature.check.md',
    'deep/nested/task1.check.md',
    '.check-state.json',
    'tasks/GH-1/.check-cycle.json',
    '.work-state.json',
    'tasks/GH-1/completion-context.json',
    'tasks/GH-1/completion-verdict.json',
    'tasks/GH-1/review-accountability.json',
    'tasks/GH-1/.last-commit-sha',
  ];
  for (const p of artifacts) {
    it(`classifies "${p}" as a workflow artifact`, () => {
      assert.equal(isWorkflowArtifactPath(p, null), true);
    });
  }
});

describe('isWorkflowArtifactPath — code is never swallowed', () => {
  // A false positive here masks a real change and lets a stale approval stand,
  // so ambiguous names must survive rule 2 when no tasks base covers them.
  const code = [
    'src/index.js',
    'docs/tasks.md',
    'docs/spec.md',
    'src/brief.md',
    'src/ticket.json',
    'src/check.md',
    'src/checkmd.check.mdx',
    'lib/checker.js',
    'test/completion-context.js',
    '',
  ];
  for (const p of code) {
    it(`classifies "${p}" as code`, () => {
      assert.equal(isWorkflowArtifactPath(p, null), false);
    });
  }
});

describe('isWorkflowArtifactPath — rule 1 (inside TASKS_BASE)', () => {
  it('treats everything under the tasks base as an artifact', () => {
    assert.equal(isWorkflowArtifactPath('tasks/GH-1/tasks.md', 'tasks'), true);
    assert.equal(isWorkflowArtifactPath('tasks/GH-1/brief.md', 'tasks'), true);
    assert.equal(isWorkflowArtifactPath('tasks/GH-1/screenshots/a.png', 'tasks'), true);
    assert.equal(isWorkflowArtifactPath('tasks', 'tasks'), true);
  });

  it('does not leak past the tasks base on a shared prefix', () => {
    assert.equal(isWorkflowArtifactPath('tasks-runner/index.js', 'tasks'), false);
    assert.equal(isWorkflowArtifactPath('src/tasks/GH-1/tasks.md', 'tasks'), false);
  });
});

describe('tasksBaseRelative — refuses to classify the whole repo', () => {
  it('returns null when TASKS_BASE is unset', () => {
    const prev = process.env.TASKS_BASE;
    delete process.env.TASKS_BASE;
    try {
      assert.equal(tasksBaseRelative(os.tmpdir()), null);
    } finally {
      if (prev !== undefined) process.env.TASKS_BASE = prev;
    }
  });
});

// ─── Against a real git repository ──────────────────────────────────────────

describe('git-backed helpers', () => {
  let repo;
  let head0;
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-diff-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    head0 = git('rev-parse', 'HEAD');
  });

  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('an artifact-only commit is not a code-relevant change, and is not drift', () => {
    fs.mkdirSync(path.join(repo, 'tasks', 'GH-1'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tasks', 'GH-1', 'completion.check.md'), '**Status:** OK\n');
    git('add', '-A');
    git('commit', '-qm', 'chore: check reports');
    const head1 = git('rev-parse', 'HEAD');

    const { known, files } = codeRelevantChangedFiles(head0, head1, repo);
    assert.equal(known, true);
    assert.deepEqual(files, []);
    assert.equal(hasCodeRelevantChanges(head0, head1, repo).changed, false);
    assert.equal(isRealHeadDrift(head0, head1, repo).drift, false);
    assert.equal(isRealHeadDrift(head0, head1, repo).artifactOnly, true);
  });

  it('a source commit IS a code-relevant change, and is drift', () => {
    const from = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'feat: change code');
    const to = git('rev-parse', 'HEAD');

    assert.deepEqual(codeRelevantChangedFiles(from, to, repo).files, ['src.js']);
    assert.equal(isRealHeadDrift(from, to, repo).drift, true);
  });

  it('a mixed commit counts as code — the artifact never hides the source file', () => {
    const from = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 3;\n');
    fs.writeFileSync(path.join(repo, 'tasks', 'GH-1', 'tests.check.md'), '**Status:** OK\n');
    git('add', '-A');
    git('commit', '-qm', 'fix: code plus reports');
    const to = git('rev-parse', 'HEAD');

    assert.deepEqual(codeRelevantChangedFiles(from, to, repo).files, ['src.js']);
    assert.equal(isRealHeadDrift(from, to, repo).drift, true);
  });

  it('fails SAFE — an unresolvable ref reports unknown, and unknown means drift', () => {
    const bogus = 'f'.repeat(40);
    assert.equal(codeRelevantChangedFiles(bogus, 'HEAD', repo).known, false);
    assert.equal(isRealHeadDrift(bogus, 'HEAD', repo).drift, true);
  });

  it('an identical sha is never drift', () => {
    assert.equal(isRealHeadDrift(head0, head0, repo).drift, false);
  });

  it('codeRelevantDiff excludes artifacts but keeps source hunks', () => {
    git('update-ref', 'refs/heads/base', head0);
    const diff = codeRelevantDiff('base', repo);
    assert.match(diff, /src\.js/);
    assert.doesNotMatch(diff, /completion\.check\.md/);
    assert.doesNotMatch(diff, /tests\.check\.md/);
  });

  it('a prefixed basename is CODE — the diff must not drop it (PR #800 review)', () => {
    // The exclusion used to be expressed as git pathspec globs, whose `*` has
    // no basename anchor: `:(exclude)*completion-context.json` also dropped
    // `src/foo-completion-context.json`, and `:(exclude)*.last-commit-sha`
    // dropped `release.last-commit-sha`. The classifier called those code, the
    // pathspecs called them artifacts, and the hash silently ignored a real
    // change. One grammar now answers the question.
    const decoys = {
      'src/foo-completion-context.json': '{"v":1}\n',
      'release.last-commit-sha': 'v1\n',
      'src/build.check-state.json': 'x\n',
      'src/my.work-state.json': 'x\n',
    };
    for (const [rel, body] of Object.entries(decoys)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
      assert.equal(isWorkflowArtifactPath(rel, 'tasks'), false, `${rel} must classify as code`);
    }
    git('add', '-A');
    git('commit', '-qm', 'add decoys');
    const from = git('rev-parse', 'HEAD');

    for (const rel of Object.keys(decoys)) fs.writeFileSync(path.join(repo, rel), 'CHANGED\n');
    git('add', '-A');
    git('commit', '-qm', 'change the decoys');
    const to = git('rev-parse', 'HEAD');

    assert.deepEqual(
      codeRelevantChangedFiles(from, to, repo).files.sort(),
      Object.keys(decoys).sort()
    );
    assert.equal(isRealHeadDrift(from, to, repo).drift, true, 'changing these must count as drift');

    git('update-ref', 'refs/heads/decoy-base', from);
    const diff = codeRelevantDiff('decoy-base', repo);
    for (const rel of Object.keys(decoys)) assert.match(diff, new RegExp(rel.replace('.', '\\.')));
  });

  it('a filename containing glob characters is treated as a literal path', () => {
    const weird = 'src/a[1]*.js';
    fs.writeFileSync(path.join(repo, weird), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'add glob-named file');
    const from = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, weird), 'y\n');
    git('add', '-A');
    git('commit', '-qm', 'change glob-named file');

    assert.deepEqual(codeRelevantChangedFiles(from, 'HEAD', repo).files, [weird]);
    git('update-ref', 'refs/heads/glob-base', from);
    assert.match(codeRelevantDiff('glob-base', repo), /a\[1\]/);
  });

  it('codeRelevantDiff returns null outside a git repository', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      assert.equal(codeRelevantDiff('main', notARepo), null);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

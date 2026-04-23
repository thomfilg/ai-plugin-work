/**
 * Tests for artifact-archival.js
 *
 * Covers STEP_ARTIFACTS and archiveStepArtifacts() extracted from work.workflow.js.
 * Uses node:test + node:assert/strict.
 * Run: node --test workflows/work/__tests__/artifact-archival.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { STEP_ARTIFACTS, archiveStepArtifacts } = require(
  path.join(__dirname, '..', 'artifact-archival')
);
const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-archival-test-'));
}

function teardown() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

function touch(name) {
  fs.writeFileSync(path.join(tmpDir, name), 'test-content', 'utf-8');
}

// ─── STEP_ARTIFACTS ─────────────────────────────────────────────────────────

describe('STEP_ARTIFACTS', () => {
  it('has patterns for the check step', () => {
    assert.ok(STEP_ARTIFACTS[STEPS.check]);
    assert.ok(Array.isArray(STEP_ARTIFACTS[STEPS.check]));
    assert.ok(STEP_ARTIFACTS[STEPS.check].length > 0);
  });

  it('has patterns for the pr step', () => {
    assert.ok(STEP_ARTIFACTS[STEPS.pr]);
    assert.ok(Array.isArray(STEP_ARTIFACTS[STEPS.pr]));
  });

  it('check patterns match .check.md files', () => {
    const patterns = STEP_ARTIFACTS[STEPS.check];
    assert.ok(patterns.some((p) => p.test('dev-quality.check.md')));
    assert.ok(patterns.some((p) => p.test('lint.check.md')));
  });

  it('pr patterns match .pr-update-sha and .post-pr-update-sha', () => {
    const patterns = STEP_ARTIFACTS[STEPS.pr];
    assert.ok(patterns.some((p) => p.test('.pr-update-sha')));
    assert.ok(patterns.some((p) => p.test('.post-pr-update-sha')));
  });

  it('does not have patterns for complete step', () => {
    assert.equal(STEP_ARTIFACTS[STEPS.complete], undefined);
  });
});

// ─── archiveStepArtifacts ───────────────────────────────────────────────────

describe('archiveStepArtifacts', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('returns null when tasksDir does not exist', () => {
    const result = archiveStepArtifacts('/nonexistent/path/xyz', [STEPS.check]);
    assert.equal(result, null);
  });

  it('returns null when no artifacts match', () => {
    const result = archiveStepArtifacts(tmpDir, [STEPS.check]);
    assert.equal(result, null);
  });

  it('returns null when steps have no artifact patterns', () => {
    touch('somefile.txt');
    const result = archiveStepArtifacts(tmpDir, [STEPS.implement]);
    assert.equal(result, null);
  });

  it('archives check artifacts to runs/run1', () => {
    touch('dev-quality.check.md');
    touch('lint.check.md');

    const result = archiveStepArtifacts(tmpDir, [STEPS.check]);
    assert.equal(result, 'runs/run1');

    // Files moved
    assert.ok(!fs.existsSync(path.join(tmpDir, 'dev-quality.check.md')));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'lint.check.md')));

    // Files in run dir
    const runDir = path.join(tmpDir, 'runs', 'run1');
    assert.ok(fs.existsSync(path.join(runDir, 'dev-quality.check.md')));
    assert.ok(fs.existsSync(path.join(runDir, 'lint.check.md')));
  });

  it('archives pr artifacts', () => {
    touch('.pr-update-sha');
    touch('.post-pr-update-sha');

    const result = archiveStepArtifacts(tmpDir, [STEPS.pr]);
    assert.equal(result, 'runs/run1');

    const runDir = path.join(tmpDir, 'runs', 'run1');
    assert.ok(fs.existsSync(path.join(runDir, '.pr-update-sha')));
    assert.ok(fs.existsSync(path.join(runDir, '.post-pr-update-sha')));
  });

  it('increments run number when previous runs exist', () => {
    // Create existing run
    fs.mkdirSync(path.join(tmpDir, 'runs', 'run1'), { recursive: true });
    touch('dev-quality.check.md');

    const result = archiveStepArtifacts(tmpDir, [STEPS.check]);
    assert.equal(result, 'runs/run2');
  });

  it('handles multiple steps in a single call', () => {
    touch('dev-quality.check.md');
    touch('.pr-update-sha');

    const result = archiveStepArtifacts(tmpDir, [STEPS.check, STEPS.pr]);
    assert.equal(result, 'runs/run1');

    const runDir = path.join(tmpDir, 'runs', 'run1');
    assert.ok(fs.existsSync(path.join(runDir, 'dev-quality.check.md')));
    assert.ok(fs.existsSync(path.join(runDir, '.pr-update-sha')));
  });

  it('only archives files matching patterns, leaves others alone', () => {
    touch('dev-quality.check.md');
    touch('unrelated-file.txt');

    archiveStepArtifacts(tmpDir, [STEPS.check]);

    // Unrelated file stays
    assert.ok(fs.existsSync(path.join(tmpDir, 'unrelated-file.txt')));
    // Artifact moved
    assert.ok(!fs.existsSync(path.join(tmpDir, 'dev-quality.check.md')));
  });

  // ─── Per-task archival (GH-259 Task 6) ──────────────────────────────────

  it('archives per-task files to runs/runN/taskM/', () => {
    // tasks.md must exist for per-task archival (GH-259)
    fs.writeFileSync(path.join(tmpDir, 'tasks.md'), '# Tasks\n', 'utf-8');
    // Create task subdirectories with artifact files
    fs.mkdirSync(path.join(tmpDir, 'task1'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'task2'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'task1', 'code-review.check.md'), 'review1', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'task2', 'tests.check.md'), 'review2', 'utf-8');

    const result = archiveStepArtifacts(tmpDir, [STEPS.check]);
    assert.equal(result, 'runs/run1');

    // Per-task files archived to per-task run dirs
    const runDir = path.join(tmpDir, 'runs', 'run1');
    assert.ok(fs.existsSync(path.join(runDir, 'task1', 'code-review.check.md')));
    assert.ok(fs.existsSync(path.join(runDir, 'task2', 'tests.check.md')));

    // Original files removed
    assert.ok(!fs.existsSync(path.join(tmpDir, 'task1', 'code-review.check.md')));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'task2', 'tests.check.md')));
  });

  it('archives root and per-task files together', () => {
    // tasks.md must exist for per-task archival (GH-259)
    fs.writeFileSync(path.join(tmpDir, 'tasks.md'), '# Tasks\n', 'utf-8');
    // Root-level artifact
    touch('dev-quality.check.md');

    // Per-task artifacts
    fs.mkdirSync(path.join(tmpDir, 'task1'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'task1', 'lint.check.md'), 'task1-lint', 'utf-8');

    const result = archiveStepArtifacts(tmpDir, [STEPS.check]);
    assert.equal(result, 'runs/run1');

    const runDir = path.join(tmpDir, 'runs', 'run1');
    // Root file at run root
    assert.ok(fs.existsSync(path.join(runDir, 'dev-quality.check.md')));
    // Per-task file in task subdir
    assert.ok(fs.existsSync(path.join(runDir, 'task1', 'lint.check.md')));

    // Originals removed
    assert.ok(!fs.existsSync(path.join(tmpDir, 'dev-quality.check.md')));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'task1', 'lint.check.md')));
  });

  it('handles single-task mode (no task dirs) unchanged', () => {
    // Only root-level files, no taskN/ directories
    touch('dev-quality.check.md');

    const result = archiveStepArtifacts(tmpDir, [STEPS.check]);
    assert.equal(result, 'runs/run1');

    const runDir = path.join(tmpDir, 'runs', 'run1');
    assert.ok(fs.existsSync(path.join(runDir, 'dev-quality.check.md')));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'dev-quality.check.md')));

    // No taskN/ dirs should exist in run dir
    const runContents = fs.readdirSync(runDir);
    const taskDirs = runContents.filter(d => /^task\d+$/.test(d));
    assert.equal(taskDirs.length, 0);
  });
});

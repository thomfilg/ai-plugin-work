const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TESTS_COMMON = path.resolve(__dirname, '..', 'tests-common.sh');

describe('tests-common.sh REPORT_FOLDER handling', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-folder-test-'));
    // Initialise a tiny git repo so tests_lib_init can detect GIT_ROOT
    execSync(
      'git init && git config user.email "test@test.com" && git config user.name "Test" && git commit --allow-empty -m init',
      {
        cwd: tmpDir,
        stdio: 'pipe',
      }
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves a pre-set REPORT_FOLDER', () => {
    const customFolder = path.join(tmpDir, 'custom-reports');
    // Source tests-common.sh with REPORT_FOLDER already set, then print it
    const script = [
      `export REPORT_FOLDER="${customFolder}"`,
      `source "${TESTS_COMMON}"`,
      `tests_lib_init`,
      `echo "$REPORT_FOLDER"`,
    ].join('\n');

    const result = execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    assert.equal(result, customFolder, 'REPORT_FOLDER should be the pre-set value');
    assert.ok(fs.existsSync(customFolder), 'mkdir -p should have created the custom folder');
  });

  it('computes default REPORT_FOLDER when not pre-set', () => {
    // Source tests-common.sh without setting REPORT_FOLDER
    const script = [
      'unset REPORT_FOLDER',
      `source "${TESTS_COMMON}"`,
      'tests_lib_init',
      'echo "$REPORT_FOLDER"',
    ].join('\n');

    const result = execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Default pattern: $HOME/worktrees/tasks/${TASK_FOLDER}
    assert.ok(
      result.includes('/worktrees/tasks/'),
      `Expected default path to contain /worktrees/tasks/, got: ${result}`
    );
    assert.ok(!result.includes('custom-reports'), 'Should not contain the custom folder name');
  });
});

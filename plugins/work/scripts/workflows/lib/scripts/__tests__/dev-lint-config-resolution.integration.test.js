/**
 * Integration tests for dev-lint.sh config resolution.
 *
 * GH-432: dev-lint.sh must fall back to the plugin's quality-rules ESLint
 * config when the repo under test does not ship a root flat config.
 *
 * These tests spawn `dev-lint.sh` against a throwaway git repo with a
 * stubbed `npx` shim on PATH so we can inspect the eslint argv without
 * needing eslint installed in node_modules.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEV_LINT_SH = path.join(
  __dirname,
  '..',
  'dev-check',
  'dev-lint.sh'
);
const QUALITY_LINT_RULES = path.join(
  __dirname,
  '..',
  'quality',
  'configs',
  'quality-lint-rules.js'
);

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-lint-config-res-'));
}

/**
 * Initialize a git repo committed on `main` then switched to a feature
 * branch, so that dev-lint.sh's `get_changed_files` sees the untracked
 * `.js` file we drop into it.
 */
function initRepo({ withRootEslintConfig = false } = {}) {
  const dir = makeTempDir();
  const run = (cmd) =>
    execSync(cmd, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

  run('git init -b main');
  run('git config user.email "t@t.com"');
  run('git config user.name "t"');

  // Minimal package.json that lists eslint as a devDependency so
  // detect_tool() resolves to "eslint".
  const pkg = { name: 'fixture', devDependencies: { eslint: '^9.0.0' } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));

  if (withRootEslintConfig) {
    fs.writeFileSync(
      path.join(dir, 'eslint.config.js'),
      'module.exports = [];\n'
    );
  }

  run('git add -A');
  run('git commit -m "initial"');
  run('git checkout -b feature');

  // Trivially clean JS file — untracked, so get_changed_files picks it up.
  fs.writeFileSync(
    path.join(dir, 'changed.js'),
    'module.exports = 1;\n'
  );

  return dir;
}

/**
 * Build a temp bin dir containing a `npx` shim that just echoes its
 * argv (prefixed with "NPX_ARGV:") and exits 0. We prepend this to PATH
 * so dev-lint.sh's `xargs npx eslint ...` is observable without needing
 * real eslint installed.
 */
function makeNpxStubBin() {
  const binDir = makeTempDir();
  const shim = path.join(binDir, 'npx');
  fs.writeFileSync(
    shim,
    '#!/bin/bash\necho "NPX_ARGV: $*"\nexit 0\n'
  );
  fs.chmodSync(shim, 0o755);
  return binDir;
}

function runDevLint(repoDir, stubBinDir, scriptPath = DEV_LINT_SH) {
  return spawnSync('bash', [scriptPath], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      _DEV_CHECK_ROOT: repoDir,
      _DEV_CHECK_BASE: 'main',
    },
  });
}

/**
 * Build an npx shim whose exit code is configurable. Used by T-4 to simulate
 * a real lint violation surfacing through dev-lint.sh.
 */
function makeNpxStubBinExiting(exitCode) {
  const binDir = makeTempDir();
  const shim = path.join(binDir, 'npx');
  fs.writeFileSync(
    shim,
    `#!/bin/bash\necho "NPX_ARGV: $*"\nexit ${exitCode}\n`
  );
  fs.chmodSync(shim, 0o755);
  return binDir;
}

/**
 * Copy dev-lint.sh + common.sh into a temp dir so $SCRIPT_DIR points at a
 * location with no sibling `../quality/...` tree. Used by T-3.
 */
function copyDevLintToIsolatedDir() {
  const isolatedDir = makeTempDir();
  fs.copyFileSync(DEV_LINT_SH, path.join(isolatedDir, 'dev-lint.sh'));
  fs.copyFileSync(
    path.join(__dirname, '..', 'dev-check', 'common.sh'),
    path.join(isolatedDir, 'common.sh')
  );
  fs.chmodSync(path.join(isolatedDir, 'dev-lint.sh'), 0o755);
  return isolatedDir;
}

/**
 * Variant of initRepo that uses a custom devDependency (e.g. "oxlint") so
 * detect_tool() resolves to a non-eslint linter. Used by T-5.
 */
function initRepoWithLinter(linterName) {
  const dir = makeTempDir();
  const run = (cmd) =>
    execSync(cmd, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });

  run('git init -b main');
  run('git config user.email "t@t.com"');
  run('git config user.name "t"');

  const pkg = {
    name: 'fixture',
    devDependencies: { [linterName]: '^1.0.0' },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));

  run('git add -A');
  run('git commit -m "initial"');
  run('git checkout -b feature');

  fs.writeFileSync(
    path.join(dir, 'changed.js'),
    'module.exports = 1;\n'
  );

  return dir;
}

describe('dev-lint.sh config resolution', () => {
  let repoDir;
  let stubBinDir;
  let extraDirs;

  beforeEach(() => {
    extraDirs = [];
  });

  afterEach(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
    if (stubBinDir) fs.rmSync(stubBinDir, { recursive: true, force: true });
    for (const d of extraDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    repoDir = undefined;
    stubBinDir = undefined;
    extraDirs = [];
  });

  // T-1 — Scenario: Repo has no root eslint.config — script falls back to the quality-rules config
  it('falls back to the quality-rules config when the repo has no root eslint.config', () => {
    repoDir = initRepo({ withRootEslintConfig: false });
    stubBinDir = makeNpxStubBin();

    const result = runDevLint(repoDir, stubBinDir);
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}. Output:\n${combined}`
    );
    assert.ok(
      !/couldn't find an eslint\.config/i.test(combined),
      `unexpected missing-config error in output:\n${combined}`
    );
    assert.match(
      combined,
      /NPX_ARGV: eslint .*--config .*quality-lint-rules\.js/,
      `expected eslint invocation with --config <quality-lint-rules.js>; got:\n${combined}`
    );
    // Sanity: the resolved fallback path must point at the real shipped file.
    assert.ok(
      fs.existsSync(QUALITY_LINT_RULES),
      `expected ${QUALITY_LINT_RULES} to exist on disk`
    );
  });

  // T-2 — Scenario: Repo has a root eslint.config.js — script uses it unchanged
  it('uses the repo-root eslint.config.js without --config when one is present', () => {
    repoDir = initRepo({ withRootEslintConfig: true });
    stubBinDir = makeNpxStubBin();

    const result = runDevLint(repoDir, stubBinDir);
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}. Output:\n${combined}`
    );
    // The invocation log must show eslint was called, but NOT with our
    // plugin-shipped quality-lint-rules.js fallback config.
    assert.match(
      combined,
      /NPX_ARGV: eslint\b/,
      `expected eslint invocation; got:\n${combined}`
    );
    assert.ok(
      !/--config\s+\S*quality-lint-rules\.js/.test(combined),
      `expected NO --config <quality-lint-rules.js> when root flat config is present; got:\n${combined}`
    );
  });

  // T-3 — Scenario: Repo has no root eslint.config AND no quality-rules fallback — skip with warning, exit 0
  it('skips with a yellow warning and exit 0 when neither root config nor fallback is reachable', () => {
    repoDir = initRepo({ withRootEslintConfig: false });
    stubBinDir = makeNpxStubBin();
    const isolatedScriptDir = copyDevLintToIsolatedDir();
    extraDirs.push(isolatedScriptDir);

    const isolatedScript = path.join(isolatedScriptDir, 'dev-lint.sh');
    const result = runDevLint(repoDir, stubBinDir, isolatedScript);
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

    assert.equal(
      result.status,
      0,
      `expected exit 0 (skip with warning), got ${result.status}. Output:\n${combined}`
    );
    assert.match(
      result.stderr || '',
      /dev-lint: no eslint flat config found/,
      `expected yellow warning on stderr; got:\n${result.stderr}`
    );
    assert.ok(
      !/NPX_ARGV: eslint\b/.test(combined),
      `expected eslint NOT to be invoked when no config is resolvable; got:\n${combined}`
    );
  });

  // T-4 — Scenario: Real lint violation still fails when fallback config is used
  it('propagates a non-zero exit when eslint reports violations against the fallback config', () => {
    repoDir = initRepo({ withRootEslintConfig: false });
    // Stub npx that simulates eslint reporting violations by exiting 1.
    // Combined with the absence of a root config, this exercises the
    // fallback config path and asserts the exit code propagates.
    stubBinDir = makeNpxStubBinExiting(1);

    const result = runDevLint(repoDir, stubBinDir);
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

    assert.notEqual(
      result.status,
      0,
      `expected non-zero exit when eslint reports violations; got 0. Output:\n${combined}`
    );
    // Sanity: confirm the fallback path was the one being invoked (so we
    // know the failure came from the fallback branch, not some other error).
    assert.match(
      combined,
      /NPX_ARGV: eslint .*--config .*quality-lint-rules\.js/,
      `expected fallback --config path in invocation; got:\n${combined}`
    );
  });

  // T-5 — Scenario: oxlint detected — unaffected by the eslint fallback path
  it('does not enter the eslint config-resolution branch when the detected linter is oxlint', () => {
    repoDir = initRepoWithLinter('oxlint');
    stubBinDir = makeNpxStubBin();

    const result = runDevLint(repoDir, stubBinDir);
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;

    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}. Output:\n${combined}`
    );
    assert.match(
      combined,
      /NPX_ARGV: oxlint\b/,
      `expected oxlint invocation; got:\n${combined}`
    );
    assert.ok(
      !/--config\s+\S*quality-lint-rules\.js/.test(combined),
      `expected NO eslint fallback --config when linter is oxlint; got:\n${combined}`
    );
    assert.ok(
      !/dev-lint: no eslint flat config found/.test(combined),
      `expected no eslint-fallback warning when linter is oxlint; got:\n${combined}`
    );
  });
});

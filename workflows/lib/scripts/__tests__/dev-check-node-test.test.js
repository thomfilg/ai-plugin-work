const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COMMON_SH = path.join(__dirname, '..', 'dev-check', 'common.sh');

/**
 * Helper: create a temp directory with a package.json and optional test files.
 * Returns the temp dir path (cleaned up via afterEach).
 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-check-test-'));
}

/**
 * Helper: run a bash snippet that sources common.sh (without triggering git/set -e side effects)
 * and calls one of our functions.
 */
function runBashFunction(fnCall, env = {}) {
  // We source common.sh in a subshell with set +e to avoid git failures in temp dirs
  const script = `
    set +e
    # Pre-set namespaced overrides so common.sh skips git-dependent discovery
    export _DEV_CHECK_ROOT="/tmp"
    export _DEV_CHECK_BASE="main"

    source "${COMMON_SH}"

    ${fnCall}
  `;

  return execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ...env },
  }).trim();
}

describe('detect_test_runner', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns vitest when vitest is in devDependencies', () => {
    const pkg = { devDependencies: { vitest: '^1.0.0' } };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const result = runBashFunction(`detect_test_runner "${tmpDir}/package.json"`);
    assert.equal(result, 'vitest');
  });

  it('returns jest when jest is in dependencies', () => {
    const pkg = { dependencies: { jest: '^29.0.0' } };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const result = runBashFunction(`detect_test_runner "${tmpDir}/package.json"`);
    assert.equal(result, 'jest');
  });

  it('prefers vitest over jest when both are present', () => {
    const pkg = { devDependencies: { vitest: '^1.0.0', jest: '^29.0.0' } };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const result = runBashFunction(`detect_test_runner "${tmpDir}/package.json"`);
    assert.equal(result, 'vitest');
  });

  it('returns node-test when test script uses node --test', () => {
    const pkg = { scripts: { test: 'node --test src/__tests__/*.test.js' } };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const result = runBashFunction(`detect_test_runner "${tmpDir}/package.json"`);
    assert.equal(result, 'node-test');
  });

  it('returns empty when no test runner is found', () => {
    const pkg = { scripts: { start: 'node index.js' } };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const result = runBashFunction(`detect_test_runner "${tmpDir}/package.json"`);
    assert.equal(result, '');
  });

  it('returns empty when package.json does not exist', () => {
    const result = runBashFunction(`detect_test_runner "${tmpDir}/nonexistent.json"`);
    assert.equal(result, '');
  });

  it('prefers vitest over node --test when both are present', () => {
    const pkg = {
      scripts: { test: 'node --test' },
      devDependencies: { vitest: '^1.0.0' },
    };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg));

    const result = runBashFunction(`detect_test_runner "${tmpDir}/package.json"`);
    assert.equal(result, 'vitest');
  });
});

describe('map_to_test_files', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('passes through test files that exist', () => {
    const testDir = path.join(tmpDir, 'lib', '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'foo.test.js'), '// test');

    const result = runBashFunction(`map_to_test_files "lib/__tests__/foo.test.js" "${tmpDir}"`);
    assert.equal(result, 'lib/__tests__/foo.test.js');
  });

  it('skips test files that do not exist', () => {
    const result = runBashFunction(`map_to_test_files "lib/__tests__/missing.test.js" "${tmpDir}"`);
    assert.equal(result, '');
  });

  it('maps source file to __tests__/basename.test.js', () => {
    const testDir = path.join(tmpDir, 'lib', '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'utils.test.js'), '// test');

    const result = runBashFunction(`map_to_test_files "lib/utils.js" "${tmpDir}"`);
    assert.equal(result, 'lib/__tests__/utils.test.js');
  });

  it('maps source file to __tests__/basename.test.ts when .test.js does not exist', () => {
    const testDir = path.join(tmpDir, 'src', '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'handler.test.ts'), '// test');

    const result = runBashFunction(`map_to_test_files "src/handler.ts" "${tmpDir}"`);
    assert.equal(result, 'src/__tests__/handler.test.ts');
  });

  it('skips source files with no matching test', () => {
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });

    const result = runBashFunction(`map_to_test_files "lib/no-test.js" "${tmpDir}"`);
    assert.equal(result, '');
  });

  it('handles multiple files and deduplicates', () => {
    const testDir = path.join(tmpDir, 'lib', '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'foo.test.js'), '// test');

    // Both the source and its test are changed — should deduplicate
    const files = 'lib/foo.js\nlib/__tests__/foo.test.js';
    const result = runBashFunction(`map_to_test_files "${files}" "${tmpDir}"`);
    assert.equal(result, 'lib/__tests__/foo.test.js');
  });

  it('handles nested directory structures', () => {
    const testDir = path.join(tmpDir, 'hooks', 'agents', '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'gate.test.js'), '// test');

    const result = runBashFunction(`map_to_test_files "hooks/agents/gate.js" "${tmpDir}"`);
    assert.equal(result, 'hooks/agents/__tests__/gate.test.js');
  });

  it('maps source file to __tests__/basename.test.jsx', () => {
    const testDir = path.join(tmpDir, 'components', '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'Button.test.jsx'), '// test');

    const result = runBashFunction(`map_to_test_files "components/Button.jsx" "${tmpDir}"`);
    assert.equal(result, 'components/__tests__/Button.test.jsx');
  });

  it('maps source file to __tests__/basename.test.tsx', () => {
    const testDir = path.join(tmpDir, 'components', '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'Card.test.tsx'), '// test');

    const result = runBashFunction(`map_to_test_files "components/Card.tsx" "${tmpDir}"`);
    assert.equal(result, 'components/__tests__/Card.test.tsx');
  });

  it('handles space-separated input (monorepo mode)', () => {
    const testDir = path.join(tmpDir, 'lib', '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'a.test.js'), '// test');
    fs.writeFileSync(path.join(testDir, 'b.test.js'), '// test');

    // Simulate monorepo PKG_FILES which are space-separated, normalized via tr
    const files = 'lib/a.js lib/b.js';
    const normalized = files.replace(/ /g, '\\n');
    const result = runBashFunction(`map_to_test_files "$(echo -e '${normalized}')" "${tmpDir}"`);
    assert.match(result, /lib\/__tests__\/a\.test\.js/);
    assert.match(result, /lib\/__tests__\/b\.test\.js/);
  });

  it('passes through root-level test files', () => {
    const testDir = path.join(tmpDir, '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'root.test.js'), '// test');

    const result = runBashFunction(`map_to_test_files "__tests__/root.test.js" "${tmpDir}"`);
    assert.equal(result, '__tests__/root.test.js');
  });

  it('maps root-level source file to __tests__/basename.test.js', () => {
    const testDir = path.join(tmpDir, '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'index.test.js'), '// test');

    const result = runBashFunction(`map_to_test_files "index.js" "${tmpDir}"`);
    assert.equal(result, '__tests__/index.test.js');
  });
});

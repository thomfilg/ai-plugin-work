const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const TEMP = path.join(os.tmpdir(), 'spec-verify-test-' + process.pid);
const SCRIPT = path.resolve(__dirname, '..', 'spec-verify.js');
let testDir;
let testCount = 0;

function setupWorktree() {
  testDir = path.join(TEMP, `worktree-${++testCount}`);
  fs.mkdirSync(testDir, { recursive: true });
  // Initialize a git repo so git rev-parse --show-toplevel works
  execFileSync('git', ['init'], { cwd: testDir, stdio: 'pipe' });
}

function writeFile(relPath, content) {
  const full = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function writeSpec(checklistLines) {
  const content = `# Spec\n\n## Summary\nTest spec\n\n## Verification Checklist\n${checklistLines.join('\n')}\n`;
  const specPath = path.join(testDir, 'spec.md');
  fs.writeFileSync(specPath, content);
  return specPath;
}

function runScript(specPath, opts = {}) {
  const args = [SCRIPT, specPath];
  if (opts.json) args.push('--json');
  try {
    const stdout = execFileSync('node', args, {
      cwd: testDir,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || '',
    };
  }
}

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));
beforeEach(() => setupWorktree());

describe('spec-verify.js', () => {
  // ── Happy Path ──────────────────────────────────────────────────────────

  it('scenario 1: FILE_EXISTS passes when file exists', () => {
    writeFile('src/foo.js', 'module.exports = {}');
    const specPath = writeSpec(['- FILE_EXISTS src/foo.js']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.success, true);
    assert.equal(json.checks[0].type, 'FILE_EXISTS');
    assert.equal(json.checks[0].passed, true);
  });

  it('scenario 2: GREP passes when pattern matches', () => {
    writeFile('src/foo.js', 'export default function foo() {}');
    const specPath = writeSpec(['- GREP src/foo.js /export default/']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('scenario 3: TEST_COUNT passes when enough tests exist', () => {
    writeFile(
      'src/__tests__/a.test.js',
      'test("a", () => {}); test("b", () => {}); test("c", () => {});'
    );
    writeFile('src/__tests__/b.test.js', 'it("d", () => {}); it("e", () => {});');
    const specPath = writeSpec(['- TEST_COUNT src/__tests__/*.test.js 3']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('scenario 4: REUSES passes when import exists', () => {
    writeFile('src/app.js', 'import { useAuth } from "./hooks";');
    const specPath = writeSpec(['- REUSES src/app.js useAuth']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────

  it('scenario 5: no checklist section = fail-open (exit 0, hasChecklist false)', () => {
    const specPath = path.join(testDir, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n\n## Summary\nNo checklist here\n');
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.hasChecklist, false);
    assert.equal(json.success, true);
  });

  it('scenario 6: inline comments are stripped before parsing', () => {
    writeFile('src/foo.js', 'module.exports = {}');
    const specPath = writeSpec(['- FILE_EXISTS src/foo.js # the main component']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
    assert.deepStrictEqual(json.checks[0].args, ['src/foo.js']);
  });

  it('scenario 7: TEST_COUNT with minimum 0 always passes', () => {
    const specPath = writeSpec(['- TEST_COUNT src/**/*.test.js 0']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  // ── Error Cases ─────────────────────────────────────────────────────────

  it('scenario 8: FILE_EXISTS fails when file missing', () => {
    const specPath = writeSpec(['- FILE_EXISTS src/nonexistent.js']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.success, false);
    assert.equal(json.checks[0].passed, false);
    assert.ok(json.checks[0].reason.includes('not found'));
  });

  it('scenario 9: GREP with malformed regex fails gracefully', () => {
    writeFile('src/foo.js', 'content');
    const specPath = writeSpec(['- GREP src/foo.js /[invalid regex/']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
    assert.ok(
      json.checks[0].reason.toLowerCase().includes('regex') ||
        json.checks[0].reason.toLowerCase().includes('invalid')
    );
  });

  it('scenario 10: unknown marker type fails with descriptive reason', () => {
    writeFile('src/foo.js', 'content');
    const specPath = writeSpec(['- FILE_EXISTS src/foo.js', '- ROUTE_EXISTS /api/foo']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    // The known check should pass
    assert.equal(json.checks[0].passed, true);
    // The unknown marker should fail with a descriptive reason
    const unknown = json.checks.find((c) => c.type === 'ROUTE_EXISTS');
    assert.ok(unknown, 'unknown marker should appear in checks');
    assert.equal(unknown.passed, false, 'unknown marker should fail');
    assert.ok(unknown.reason.includes('Unknown marker type'), 'reason should mention unknown type');
  });

  it('empty checklist (header but no markers) fails', () => {
    const specPath = writeSpec([]);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.hasChecklist, true);
    assert.equal(json.success, false);
  });

  // ── Security ────────────────────────────────────────────────────────────

  it('rejects path traversal with .. in marker args', () => {
    const specPath = writeSpec(['- FILE_EXISTS ../../../etc/passwd']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
    assert.ok(
      json.checks[0].reason.includes('traversal') || json.checks[0].reason.includes('rejected')
    );
  });

  it('rejects absolute paths in marker args', () => {
    const specPath = writeSpec(['- FILE_EXISTS /etc/passwd']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
  });

  // ── Human-readable output ──────────────────────────────────────────────

  it('produces human-readable output by default (no --json)', () => {
    writeFile('src/foo.js', 'module.exports = {}');
    const specPath = writeSpec(['- FILE_EXISTS src/foo.js', '- FILE_EXISTS src/bar.js']);
    const result = runScript(specPath);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.includes('[PASS]'));
    assert.ok(result.stdout.includes('[FAIL]'));
    assert.ok(result.stdout.includes('1/2'));
  });

  // ── GREP with flags ────────────────────────────────────────────────────

  it('GREP supports regex flags like /pattern/i', () => {
    writeFile('src/foo.js', 'EXPORT DEFAULT function foo() {}');
    const specPath = writeSpec(['- GREP src/foo.js /export default/i']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  // ── GREP /s flag cross-line (GH-304 Task 3) ────────────────────────────

  it('GREP with /s flag matches a pattern across multiple lines (G-S5)', () => {
    writeFile(
      'src/component.jsx',
      'export const C = () => (\n  <List\n    selectedIds={ids}\n    onSelectedIdsChange={setIds}\n  />\n);'
    );
    const specPath = writeSpec(['- GREP src/component.jsx /selectedIds.*onSelectedIdsChange/s']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('GREP without /s flag still fails on cross-line patterns (regression) [G-S6]', () => {
    writeFile(
      'src/component.jsx',
      'export const C = () => (\n  <List\n    selectedIds={ids}\n    onSelectedIdsChange={setIds}\n  />\n);'
    );
    const specPath = writeSpec(['- GREP src/component.jsx /selectedIds.*onSelectedIdsChange/']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
  });

  // ── REUSES with require ────────────────────────────────────────────────

  it('REUSES detects require() style imports', () => {
    writeFile('src/app.js', "const { useAuth } = require('./hooks');");
    const specPath = writeSpec(['- REUSES src/app.js useAuth']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('REUSES detects multiline require() split across lines', () => {
    writeFile('src/app.js', "const { useAuth } = require(\n  './hooks'\n);");
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('REUSES ignores require() inside single-line comments', () => {
    writeFile('src/app.js', "// const { useAuth } = require('./hooks');");
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
  });

  it('REUSES ignores require() inside block comments', () => {
    writeFile('src/app.js', "/* require('./hooks') */\nconst x = 1;");
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
  });

  it('REUSES preserves // inside string literals when stripping comments', () => {
    writeFile('src/app.js', 'const url = "https://api"; const { useAuth } = require(\'./hooks\');');
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('REUSES preserves // inside regex literals when stripping comments', () => {
    writeFile('src/app.js', "const re = /https?:\\/\\//; const { useAuth } = require('./hooks');");
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('REUSES ignores require() inside template literals', () => {
    writeFile('src/app.js', "const example = `require(\n  './hooks'\n)`;");
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
  });

  it('REUSES handles regex with quote char before require on same line', () => {
    writeFile('src/app.js', "const re = /\\'/; const { useAuth } = require('./hooks');");
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('REUSES detects require() inside template literal interpolation', () => {
    writeFile('src/app.js', "const x = `${require('./hooks')}`;");
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('REUSES ignores require() inside regular string literals', () => {
    writeFile('src/app.js', 'const s = "require(\'./hooks\')";');
    const specPath = writeSpec(['- REUSES src/app.js hooks']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
  });

  // ── REUSES multi-line + alias-path imports (GH-304) ────────────────────

  it('REUSES matches symbol in multi-line import block', () => {
    writeFile(
      'src/app.js',
      "import {\n  useAuth,\n  useUser,\n} from './hooks';"
    );
    const specPath = writeSpec(['- REUSES src/app.js useAuth']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('REUSES matches symbol via alias path import', () => {
    writeFile('src/app.js', "import { fetchUsers } from '@/app/api/users';");
    const specPath = writeSpec(['- REUSES src/app.js fetchUsers']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('REUSES matches symbol in multi-line import that uses an alias path', () => {
    writeFile(
      'src/app.js',
      "import {\n  fetchUsers,\n  createUser,\n} from '@/app/api/users';"
    );
    const specPath = writeSpec(['- REUSES src/app.js createUser']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  // ── REUSES default + namespace imports & failure hint (GH-304 Task 2) ─

  it('REUSES matches default and namespace imports when symbol matches the local binding', () => {
    writeFile('src/auth.js', "import Auth from '@/app/auth';");
    const specPath = writeSpec(['- REUSES src/auth.js Auth']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);

    setupWorktree();
    writeFile('src/users.js', "import * as Users from '@/app/users';");
    const specPath2 = writeSpec(['- REUSES src/users.js Users']);
    const result2 = runScript(specPath2, { json: true });
    assert.equal(result2.exitCode, 0);
    const json2 = JSON.parse(result2.stdout);
    assert.equal(json2.checks[0].passed, true);
  });

  it('REUSES failure message hints at the multi-line and alias scenarios that were checked', () => {
    writeFile('src/app.js', 'const x = 1;');
    const specPath = writeSpec(['- REUSES src/app.js nonExistentSymbol']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
    const reason = json.checks[0].reason || '';
    assert.ok(reason.includes('multi-line'), `reason should hint at multi-line: ${reason}`);
    assert.ok(reason.includes('import'), `reason should hint at import: ${reason}`);
  });

  // ── GREP glob path support (GH-304 Task 4) ─────────────────────────────

  it('GREP supports glob patterns in the file-path argument', () => {
    writeFile('src/a.tsx', 'const x = 1;');
    writeFile('src/b.tsx', 'import { useFeatureFlag } from "./flags";');
    const specPath = writeSpec(['- GREP src/**/*.tsx /useFeatureFlag/']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, true);
  });

  it('GREP with glob fails when no matched file contains the pattern', () => {
    writeFile('src/a.tsx', 'const x = 1;');
    writeFile('src/b.tsx', 'const y = 2;');
    const specPath = writeSpec(['- GREP src/**/*.tsx /useFeatureFlag/']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
    assert.ok(
      json.checks[0].reason.includes('src/**/*.tsx'),
      `reason should mention the glob pattern: ${json.checks[0].reason}`
    );
  });

  it('GREP with /g regex does not leak lastIndex across glob-matched files', () => {
    // Regression: a /g regex matched in file A advances lastIndex; without a
    // reset, .test() against file B starts mid-content and can produce a
    // false PASS when the pattern is absent. Here every file is empty of the
    // pattern, but a prior file in the same scan contains it — so without the
    // fix the second file's .test() would PASS spuriously.
    writeFile('src/a.tsx', 'useFeatureFlag\nuseFeatureFlag\nuseFeatureFlag');
    writeFile('src/b.tsx', 'no pattern here at all');
    // Use a glob that matches a.tsx first; the gate should still inspect each
    // file independently. We pick a non-matching pattern so PASS would only
    // come from a leaked lastIndex.
    writeFile('src/c.tsx', 'nothing relevant');
    const specPath = writeSpec(['- GREP src/**/*.tsx /missingToken/g']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
  });

  it('GREP rejects glob pattern with .. segments after a wildcard (traversal)', () => {
    writeFile('src/a.tsx', 'const x = 1;');
    const specPath = writeSpec(['- GREP src/**/../../../outside/*.tsx /anything/']);
    const result = runScript(specPath, { json: true });
    assert.equal(result.exitCode, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.checks[0].passed, false);
    assert.match(json.checks[0].reason, /Path traversal rejected/);
  });

  // ── REUSES local definitions (GH-327) ──────────────────────────────────

  describe('REUSES local definitions (GH-327)', () => {
    // --- Local definitions (RED — production code does not support yet) ---

    it('REUSES detects local function declaration', () => {
      writeFile('src/utils.js', 'function ghExec(args) { return args; }');
      const specPath = writeSpec(['- REUSES src/utils.js ghExec']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, true);
    });

    it('REUSES detects local const assignment', () => {
      writeFile('src/utils.js', 'const ghExec = (args) => args;');
      const specPath = writeSpec(['- REUSES src/utils.js ghExec']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, true);
    });

    it('REUSES detects local let assignment', () => {
      writeFile('src/utils.js', 'let counter = 0;');
      const specPath = writeSpec(['- REUSES src/utils.js counter']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, true);
    });

    it('REUSES detects local var assignment', () => {
      writeFile('src/utils.js', 'var oldStyle = true;');
      const specPath = writeSpec(['- REUSES src/utils.js oldStyle']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, true);
    });

    // --- Regression tests (should PASS with current code) ---

    it('REUSES regression: ES import still passes', () => {
      writeFile('src/app.js', 'import { useAuth } from "./hooks";');
      const specPath = writeSpec(['- REUSES src/app.js useAuth']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, true);
    });

    it('REUSES regression: require import still passes', () => {
      writeFile('src/app.js', "const { useAuth } = require('./hooks');");
      const specPath = writeSpec(['- REUSES src/app.js useAuth']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, true);
    });

    // --- Negative tests (should correctly FAIL) ---

    it('REUSES fails when symbol is not present in file', () => {
      writeFile('src/app.js', 'const x = 1;');
      const specPath = writeSpec(['- REUSES src/app.js nonExistent']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, false);
      assert.ok(json.checks[0].reason.includes('definition'), 'reason should mention definition');
    });

    it('REUSES fails for commented-out function definition', () => {
      writeFile('src/app.js', '// function ghExec(args) {}');
      const specPath = writeSpec(['- REUSES src/app.js ghExec']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, false);
    });

    it('REUSES fails for block-commented definition', () => {
      writeFile('src/app.js', '/* const ghExec = 1; */\nconst x = 2;');
      const specPath = writeSpec(['- REUSES src/app.js ghExec']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, false);
    });

    it('REUSES fails for partial name match (word boundary)', () => {
      writeFile('src/app.js', 'function ghExecHelper(args) {}');
      const specPath = writeSpec(['- REUSES src/app.js ghExec']);
      const result = runScript(specPath, { json: true });
      assert.equal(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.equal(json.checks[0].passed, false);
    });
  });
});

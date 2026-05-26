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

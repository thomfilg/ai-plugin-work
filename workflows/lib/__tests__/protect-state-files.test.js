/**
 * Tests for lib/protect-state-files.js
 *
 * Run: node --test lib/__tests__/protect-state-files.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  FILE_WRITE_TOOLS,
  BASH_WRITE_OPS,
  NODE_FS_WRITES,
  INLINE_INTERPRETER_PATTERN,
  INLINE_INTERPRETER_WRITES,
  BASE64_EVASION_PATTERN,
  buildProtectedBasenames,
  basenameProtector,
  createFileProtector,
} = require('../protect-state-files');

// ─── buildProtectedBasenames ────────────────────────────────────────────────

describe('buildProtectedBasenames', () => {
  it('builds set from workflows + extras', () => {
    const workflows = [
      { stateFile: '.state.json', evidenceFile: '.evidence.json' },
      { stateFile: '.wf-state.json', evidenceFile: '.wf-evidence.json' },
    ];
    const set = buildProtectedBasenames(workflows, ['.actions.json']);
    assert.equal(set.size, 5);
    assert.ok(set.has('.state.json'));
    assert.ok(set.has('.evidence.json'));
    assert.ok(set.has('.wf-state.json'));
    assert.ok(set.has('.wf-evidence.json'));
    assert.ok(set.has('.actions.json'));
  });

  it('works with empty workflows and no extras', () => {
    const set = buildProtectedBasenames([]);
    assert.equal(set.size, 0);
  });
});

// ─── basenameProtector ──────────────────────────────────────────────────────

describe('basenameProtector', () => {
  const check = basenameProtector(new Set(['.secret.json', '.state.json']));

  it('returns basename when protected', () => {
    assert.equal(check('/some/path/.secret.json'), '.secret.json');
    assert.equal(check('/tmp/random/.state.json'), '.state.json');
  });

  it('returns null for non-protected files', () => {
    assert.equal(check('/some/path/package.json'), null);
    assert.equal(check('/tmp/index.js'), null);
  });

  it('returns null for empty path', () => {
    assert.equal(check(''), null);
  });
});

// ─── createFileProtector — Edit/Write/MultiEdit ─────────────────────────────

describe('createFileProtector — file tools', () => {
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.secret.json', '.state.json'])),
  });

  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    it(`blocks ${tool} to protected file`, () => {
      const result = protector.check(tool, { file_path: `/tmp/.secret.json` });
      assert.equal(result.blocked, true);
      assert.equal(result.match, '.secret.json');
      assert.equal(result.vector, tool);
      assert.ok(result.message.includes('BLOCKED'));
      assert.equal(result.skipRemainingChecks, true);
    });

    it(`allows ${tool} to non-protected file`, () => {
      const result = protector.check(tool, { file_path: `/tmp/package.json` });
      assert.equal(result.blocked, false);
      assert.equal(result.skipRemainingChecks, true);
    });

    it(`allows ${tool} with empty file_path`, () => {
      const result = protector.check(tool, { file_path: '' });
      assert.equal(result.blocked, false);
      assert.equal(result.skipRemainingChecks, true);
    });
  }

  it('skipRemainingChecks is true even when not blocked (file tools)', () => {
    const result = protector.check('Write', { file_path: '/tmp/safe.txt' });
    assert.equal(result.blocked, false);
    assert.equal(result.skipRemainingChecks, true);
  });
});

// ─── createFileProtector — Bash vectors ─────────────────────────────────────

describe('createFileProtector — Bash', () => {
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.state.json', '.evidence.json'])),
  });

  it('blocks redirect (>) to protected file', () => {
    const result = protector.check('Bash', { command: 'echo "{}" > /tmp/.state.json' });
    assert.equal(result.blocked, true);
    assert.equal(result.vector, 'Bash');
    assert.equal(result.skipRemainingChecks, false);
  });

  it('blocks append (>>) to protected file', () => {
    const result = protector.check('Bash', { command: 'echo "x" >> /tasks/.evidence.json' });
    assert.equal(result.blocked, true);
  });

  it('blocks tee to protected file', () => {
    const result = protector.check('Bash', { command: 'echo "{}" | tee /tmp/.state.json' });
    assert.equal(result.blocked, true);
  });

  it('blocks cp to protected file', () => {
    const result = protector.check('Bash', { command: 'cp /tmp/fake.json /tasks/.state.json' });
    assert.equal(result.blocked, true);
  });

  it('blocks mv to protected file', () => {
    const result = protector.check('Bash', { command: 'mv /tmp/x .evidence.json' });
    assert.equal(result.blocked, true);
  });

  it('blocks node -e writeFileSync to protected file', () => {
    const result = protector.check('Bash', { command: 'node -e "fs.writeFileSync(\'.state.json\', \'{}\')"' });
    assert.equal(result.blocked, true);
  });

  it('allows read-only cat of protected file', () => {
    const result = protector.check('Bash', { command: 'cat /tmp/.state.json' });
    assert.equal(result.blocked, false);
  });

  it('allows redirect to non-protected file', () => {
    const result = protector.check('Bash', { command: 'echo "x" > /tmp/output.json' });
    assert.equal(result.blocked, false);
  });

  it('allows empty command', () => {
    const result = protector.check('Bash', { command: '' });
    assert.equal(result.blocked, false);
  });

  it('skipRemainingChecks is false for Bash', () => {
    const result = protector.check('Bash', { command: 'echo "x" > /tmp/.state.json' });
    assert.equal(result.skipRemainingChecks, false);
  });

  // ── Operator-adjacent tokens (bypass prevention) ──────────────────────

  it('blocks operator-adjacent redirect >>.state.json (no space)', () => {
    const result = protector.check('Bash', { command: 'echo x>>.state.json' });
    assert.equal(result.blocked, true, 'Should block >> adjacent to protected file');
  });

  it('blocks operator-adjacent redirect >.state.json (no space)', () => {
    const result = protector.check('Bash', { command: 'echo x>.state.json' });
    assert.equal(result.blocked, true, 'Should block > adjacent to protected file');
  });

  it('blocks dd of=.state.json (operator-adjacent)', () => {
    const result = protector.check('Bash', { command: 'dd if=/dev/zero of=.state.json' });
    assert.equal(result.blocked, true, 'Should block dd of= adjacent to protected file');
  });
});

// ─── createFileProtector — script bypass detection ──────────────────────────

describe('createFileProtector — script bypass', () => {
  const os = require('os');
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.state.json'])),
  });

  it('blocks script that writes to protected file', () => {
    // Create a temporary script that writes to .state.json
    const tmpScript = path.join(os.tmpdir(), `test-script-${process.pid}.js`);
    fs.writeFileSync(tmpScript, 'const fs = require("fs"); fs.writeFileSync(".state.json", "{}");');
    try {
      const result = protector.check('Bash', { command: `node ${tmpScript}` });
      assert.equal(result.blocked, true);
      assert.ok(result.vector.startsWith('Bash(script'));
    } finally {
      fs.unlinkSync(tmpScript);
    }
  });

  it('allows script that only reads protected file', () => {
    const tmpScript = path.join(os.tmpdir(), `test-script-read-${process.pid}.js`);
    fs.writeFileSync(tmpScript, 'const fs = require("fs"); const data = fs.readFileSync(".state.json"); console.log(data);');
    try {
      const result = protector.check('Bash', { command: `node ${tmpScript}` });
      assert.equal(result.blocked, false);
    } finally {
      fs.unlinkSync(tmpScript);
    }
  });

  it('allows script that writes to non-protected file', () => {
    const tmpScript = path.join(os.tmpdir(), `test-script-safe-${process.pid}.js`);
    fs.writeFileSync(tmpScript, 'const fs = require("fs"); fs.writeFileSync("output.json", "{}");');
    try {
      const result = protector.check('Bash', { command: `node ${tmpScript}` });
      assert.equal(result.blocked, false);
    } finally {
      fs.unlinkSync(tmpScript);
    }
  });

  it('allows when script does not exist (fail-open)', () => {
    const result = protector.check('Bash', { command: 'node /tmp/nonexistent-12345.js' });
    assert.equal(result.blocked, false);
  });

  // ── Test-path exclusion (GH-191 Fix 3) ──────────────────────────────────

  it('allows git-tracked test file in __tests__/ that references protected state files (GH-191)', () => {
    // Use real git-tracked test files from the repo — this is the exact false-positive scenario
    // These files contain writeFileSync + state file references in their source
    const repoRoot = require('child_process').execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const testScript = path.join(repoRoot, 'workflows', 'work', '__tests__', 'work-state.test.js');
    // This file is git-tracked and in __tests__/ — should be exempt from Vector 3
    const result = protector.check('Bash', { command: `node ${testScript}` });
    assert.equal(result.blocked, false, 'Git-tracked files in __tests__/ should skip Vector 3');
  });

  it('allows git-tracked test file in nested __tests__/ directory (GH-191)', () => {
    const repoRoot = require('child_process').execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const testScript = path.join(repoRoot, 'workflows', 'lib', '__tests__', 'protect-state-files.test.js');
    const result = protector.check('Bash', { command: `node ${testScript}` });
    assert.equal(result.blocked, false, 'Git-tracked test files in nested __tests__/ should skip Vector 3');
  });

  it('blocks untracked script in __tests__/ directory (GH-191)', () => {
    // Create an untracked file in a temp __tests__/ dir — should be blocked (not git-tracked)
    const repoRoot = require('child_process').execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const tempBase = path.join(repoRoot, `__tests__-gh191-temp-${process.pid}`);
    const testDir = path.join(tempBase, '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    const untrackedScript = path.join(testDir, 'malicious.js');
    fs.writeFileSync(untrackedScript, 'const fs = require("fs"); fs.writeFileSync(".state.json", "{}");');
    try {
      const result = protector.check('Bash', { command: `node ${untrackedScript}` });
      assert.equal(result.blocked, true, 'Untracked scripts in __tests__/ should still be blocked');
    } finally {
      fs.rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it('blocks script with test suffix outside __tests__/ or __mocks__/ (GH-191)', () => {
    const evilScript = path.join(os.tmpdir(), `evil.test.js`);
    fs.writeFileSync(evilScript, 'const fs = require("fs"); fs.writeFileSync(".state.json", "{}");');
    try {
      const result = protector.check('Bash', { command: `node ${evilScript}` });
      assert.equal(result.blocked, true, 'Scripts with test suffix outside trusted dirs should be blocked');
    } finally {
      fs.unlinkSync(evilScript);
    }
  });

  it('blocks script outside repo root even if in __tests__/ directory (GH-191)', () => {
    const baseDir = path.join(os.tmpdir(), `outside-repo-${Date.now()}`);
    const testDir = path.join(baseDir, '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    const evilScript = path.join(testDir, 'sneaky.test.js');
    fs.writeFileSync(evilScript, 'const fs = require("fs"); fs.writeFileSync(".state.json", "{}");');
    try {
      const result = protector.check('Bash', { command: `node ${evilScript}` });
      assert.equal(result.blocked, true, '__tests__/ outside repo root should still be blocked');
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('still blocks non-test script that writes to protected file (GH-191)', () => {
    const evilScript = path.join(os.tmpdir(), `evil-script.js`);
    fs.writeFileSync(evilScript, 'const fs = require("fs"); fs.writeFileSync(".state.json", "{}");');
    try {
      const result = protector.check('Bash', { command: `node ${evilScript}` });
      assert.equal(result.blocked, true, 'Non-test scripts should still be blocked by Vector 3');
    } finally {
      fs.unlinkSync(evilScript);
    }
  });
});

// ─── createFileProtector — inline interpreter bypass ─────────────────────────

describe('createFileProtector — inline interpreter bypass', () => {
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.state.json'])),
  });

  it('blocks python3 -c writing to protected file', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "open(\'.state.json\',\'w\').write(\'{}\')"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
    assert.equal(result.vector, 'Bash(python3 -c)');
    assert.equal(result.skipRemainingChecks, false);
  });

  it('blocks ruby -e writing to protected file', () => {
    const result = protector.check('Bash', {
      command: 'ruby -e "File.write(\'.state.json\', \'{}\')"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
    assert.equal(result.vector, 'Bash(ruby -e)');
  });

  it('blocks perl -e writing to protected file', () => {
    const result = protector.check('Bash', {
      command: 'perl -e "open(my $fh, \'>\', \'.state.json\'); print $fh \'{}\'"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
    // Vector may be 'Bash' (shell redirect detection) or 'Bash(perl -e)' depending on detection order
    assert.ok(result.vector.startsWith('Bash'));
  });

  it('blocks /usr/bin/env python3 -c (env prefix)', () => {
    const result = protector.check('Bash', {
      command: '/usr/bin/env python3 -c "open(\'.state.json\',\'w\').write(\'{}\')"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
    assert.equal(result.vector, 'Bash(python3 -c)');
  });

  it('blocks python3 -c os.rename to protected file', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "import os; os.rename(\'/tmp/x\', \'.state.json\')"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
  });

  it('blocks python3 -c with base64 evasion', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "import base64; open(base64.b64decode(\'LnN0YXRlLmpzb24=\').decode(),\'w\').write(\'{}\')"',
    });
    assert.equal(result.blocked, true);
    assert.ok(result.vector.includes('base64'));
  });
  // Tests below verify non-blocking cases for inline interpreter detection
  it('allows benign python3 -c (no write, no protected file)', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "print(\'hello\')"',
    });
    assert.equal(result.blocked, false);
  });

  it('allows benign python3 -c with os usage but no write', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" somefile',
    });
    assert.equal(result.blocked, false);
  });

  it('allows benign read-only python3 -c open() with no write mode', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "data = open(\'.state.json\').read()"',
    });
    assert.equal(result.blocked, false, 'read-only open() should not be blocked — regression test for greedy open() FP');
    assert.equal(result.skipRemainingChecks, false);
  }); // open() read-only false-positive regression covered above

  it('allows python3 -c open() with binary read mode br', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "data = open(\'.state.json\',\'br\').read()"',
    });
    assert.equal(result.blocked, false, 'binary read mode br should not be blocked');
  });

  it('allows python3 -c open() with binary read mode rb', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "data = open(\'.state.json\',\'rb\').read()"',
    });
    assert.equal(result.blocked, false, 'binary read mode rb should not be blocked');
  });

  it('blocks python3 -c open() with explicit write mode', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "open(\'.state.json\',\'w\').write(\'{}\')"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
  });

  it('allows when isExempt returns true', () => {
    const exemptProtector = createFileProtector({
      isProtected: basenameProtector(new Set(['.state.json'])),
      isExempt: () => true,
    });
    const result = exemptProtector.check('Bash', {
      command: 'python3 -c "open(\'.state.json\',\'w\').write(\'{}\')"',
    });
    assert.equal(result.blocked, false);
  });

  it('exposes checkInlineInterpreterBypass for testability', () => {
    assert.equal(typeof protector.checkInlineInterpreterBypass, 'function');
  });

  it('blocks python3 -c open() with exclusive create mode x', () => {
    const result = protector.check('Bash', {
      command: "python3 -c \"open('.state.json','x').write('{}')\"",
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
  });

  it('blocks python3 -c open() with read+write mode r+', () => {
    const result = protector.check('Bash', {
      command: "python3 -c \"open('.state.json','r+').write('{}')\"",
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
  });

  it('blocks piped stdin python3 -c writing to protected file', () => {
    const result = protector.check('Bash', {
      command: 'echo "data" | python3 -c "import sys; open(\'.state.json\',\'w\').write(sys.stdin.read())"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
  });

  // ── Scoped inline code extraction (false positive prevention) ──────────

  it('allows when protected filename appears outside inline code', () => {
    // .state.json is in the echo segment, NOT in the python3 -c code
    const result = protector.check('Bash', {
      command: 'echo .state.json; python3 -c "open(\'x\',\'w\').write(\'test\')"',
    });
    assert.equal(result.blocked, false, 'protected filename outside inline code should not trigger block');
  });

  it('allows base64 outside inline python3 -c code', () => {
    // base64 is a CLI command piped into python, not inside the -c code
    const result = protector.check('Bash', {
      command: 'base64 somefile | python3 -c "open(\'output.txt\',\'w\').write(\'x\')"',
    });
    assert.equal(result.blocked, false, 'base64 outside inline -c code should not trigger base64 evasion blocking');
  });

  it('allows python3 -c open().read() with print containing w (Fix 2)', () => {
    // open('.state.json').read() is read-only; the 'w' in print('w') is not a write mode
    const result = protector.check('Bash', {
      command: "python3 -c \"open('.state.json').read(); print('w')\"",
    });
    assert.equal(result.blocked, false, 'read-only open() with print("w") should not be blocked');
  });

  it('does not trigger base64 evasion when base64 is piped after -c code (Fix 1)', () => {
    // base64 is a separate command in the pipeline, not part of the inline code
    const result = protector.check('Bash', {
      command: 'python3 -c "print(\'hello\')" | base64',
    });
    assert.equal(result.blocked, false, 'base64 in pipeline after -c code should not trigger base64 evasion');
  });

  it('still blocks base64 evasion inside inline python3 -c code', () => {
    const result = protector.check('Bash', {
      command: 'python3 -c "import base64; open(base64.b64decode(\'LnN0YXRlLmpzb24=\').decode(),\'w\').write(\'{}\')"',
    });
    assert.equal(result.blocked, true);
    assert.ok(result.vector.includes('base64'));
  });

  it('blocks second interpreter in compound command', () => {
    // First python3 -c is benign, second writes to protected file
    const result = protector.check('Bash', {
      command: 'python3 -c "print(1)"; python3 -c "open(\'.state.json\',\'w\').write(\'x\')"',
    });
    assert.equal(result.blocked, true, 'should detect write in second interpreter invocation');
    assert.equal(result.vector, 'Bash(python3 -c)');
  });
});

// ─── createFileProtector — isExempt ─────────────────────────────────────────

describe('createFileProtector — exemptions', () => {
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.state.json'])),
    isExempt: (toolName, toolInput, hookData) => hookData?.isAdmin === true,
  });

  it('blocks when not exempt', () => {
    const result = protector.check('Write', { file_path: '/tmp/.state.json' }, { isAdmin: false });
    assert.equal(result.blocked, true);
  });

  it('allows when exempt', () => {
    const result = protector.check('Write', { file_path: '/tmp/.state.json' }, { isAdmin: true });
    assert.equal(result.blocked, false);
  });

  it('exemption works for Bash too', () => {
    const result = protector.check('Bash', { command: 'echo > .state.json' }, { isAdmin: true });
    assert.equal(result.blocked, false);
  });
});

// ─── Vector 3: isTrustedTestScript integration (GH-141 + GH-191) ────────────
// The false-positive fix for GH-141 is now handled by isTrustedTestScript (GH-191),
// which skips Vector 3 for in-repo, git-tracked files inside __tests__/ or __mocks__/.
// Dedicated isTrustedTestScript tests exist above (GH-191 block). Here we verify
// that the integration with checkScriptBypass works end-to-end using real repo files.

describe('checkScriptBypass — isTrustedTestScript integration (GH-141)', () => {
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.state.json', '.work-state.json', '.step-evidence.json'])),
  });

  it('skips scanning in-repo test files that reference protected filenames (GH-141 false-positive)', () => {
    // Use THIS test file — it's in __tests__/, git-tracked, and contains writeFileSync calls
    const thisTestFile = path.resolve(__dirname, 'protect-state-files.test.js');
    const result = protector.check('Bash', { command: `node --test ${thisTestFile}` });
    assert.equal(result.blocked, false, 'In-repo __tests__/ files should be skipped by isTrustedTestScript');
  });

  it('skips scanning in-repo enforce-step-workflow test file', () => {
    const enforceTest = path.resolve(__dirname, 'enforce-step-workflow.test.js');
    const result = protector.check('Bash', { command: `node --test ${enforceTest}` });
    assert.equal(result.blocked, false, 'In-repo __tests__/ files should be skipped');
  });

  it('still blocks non-test scripts outside the repo that write to protected files', () => {
    const os = require('os');
    const tmpDir = path.join(os.tmpdir(), `test-fp-prod-${process.pid}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const prodScript = path.join(tmpDir, 'evil-script.js');
    fs.writeFileSync(prodScript, 'const fs = require("fs"); fs.writeFileSync(".state.json", "{}");');
    try {
      const result = protector.check('Bash', { command: `node ${prodScript}` });
      assert.equal(result.blocked, true, 'non-test scripts should still be blocked');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── createFileProtector — formatMessage ────────────────────────────────────

describe('createFileProtector — custom message', () => {
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.state.json'])),
    formatMessage: (match, vector) => `CUSTOM: ${vector} blocked on ${match}\n`,
  });

  it('uses custom message for file tools', () => {
    const result = protector.check('Edit', { file_path: '/tmp/.state.json' });
    assert.equal(result.message, 'CUSTOM: Edit blocked on .state.json\n');
  });

  it('uses custom message for Bash', () => {
    const result = protector.check('Bash', { command: 'echo > .state.json' });
    assert.equal(result.message, 'CUSTOM: Bash blocked on .state.json\n');
  });
});

// ─── createFileProtector — custom isProtected ───────────────────────────────

describe('createFileProtector — custom isProtected', () => {
  // Protect any file under /secrets/ directory
  const protector = createFileProtector({
    isProtected: (filePath) => {
      if (filePath.includes('/secrets/')) return filePath;
      return null;
    },
  });

  it('blocks Write to file under /secrets/', () => {
    const result = protector.check('Write', { file_path: '/app/secrets/key.pem' });
    assert.equal(result.blocked, true);
    assert.ok(result.match.includes('/secrets/'));
  });

  it('allows Write to file outside /secrets/', () => {
    const result = protector.check('Write', { file_path: '/app/src/index.js' });
    assert.equal(result.blocked, false);
  });

  it('blocks Bash redirect into /secrets/', () => {
    const result = protector.check('Bash', { command: 'echo "key" > /app/secrets/key.pem' });
    assert.equal(result.blocked, true);
  });
});

// ─── Non-file tools pass through ────────────────────────────────────────────

describe('createFileProtector — non-file tools', () => {
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.state.json'])),
  });

  for (const tool of ['Task', 'Skill', 'Read', 'Glob', 'Grep']) {
    it(`passes through ${tool} tool unchanged`, () => {
      const result = protector.check(tool, { file_path: '.state.json' });
      assert.equal(result.blocked, false);
      assert.equal(result.skipRemainingChecks, false);
    });
  }
});

// ─── Constants exported ─────────────────────────────────────────────────────

describe('exported constants', () => {
  it('FILE_WRITE_TOOLS contains Write, Edit, MultiEdit', () => {
    assert.ok(FILE_WRITE_TOOLS.has('Write'));
    assert.ok(FILE_WRITE_TOOLS.has('Edit'));
    assert.ok(FILE_WRITE_TOOLS.has('MultiEdit'));
    assert.equal(FILE_WRITE_TOOLS.size, 3);
  });

  it('BASH_WRITE_OPS matches shell operators', () => {
    assert.ok(BASH_WRITE_OPS.test('echo > file'));
    assert.ok(BASH_WRITE_OPS.test('echo >> file'));
    assert.ok(BASH_WRITE_OPS.test('tee file'));
    assert.ok(BASH_WRITE_OPS.test('cp a b'));
    assert.ok(BASH_WRITE_OPS.test('mv a b'));
    assert.ok(BASH_WRITE_OPS.test('dd if=/dev/zero of=file'));
    assert.ok(!BASH_WRITE_OPS.test('cat file'));
    assert.ok(!BASH_WRITE_OPS.test('echo hello'));
  });

  it('NODE_FS_WRITES matches fs write calls', () => {
    assert.ok(NODE_FS_WRITES.test('writeFileSync'));
    assert.ok(NODE_FS_WRITES.test('appendFileSync'));
    assert.ok(NODE_FS_WRITES.test('writeFile'));
    assert.ok(NODE_FS_WRITES.test('createWriteStream'));
    assert.ok(!NODE_FS_WRITES.test('readFileSync'));
    assert.ok(!NODE_FS_WRITES.test('existsSync'));
  });

  it('INLINE_INTERPRETER_PATTERN matches inline interpreter invocations', () => {
    assert.ok(INLINE_INTERPRETER_PATTERN.test('python3 -c "print(1)"'));
    assert.ok(INLINE_INTERPRETER_PATTERN.test('python -c "print(1)"'));
    assert.ok(INLINE_INTERPRETER_PATTERN.test('python2 -c "print(1)"'));
    assert.ok(INLINE_INTERPRETER_PATTERN.test('ruby -e "puts 1"'));
    assert.ok(INLINE_INTERPRETER_PATTERN.test('perl -e "print 1"'));
    assert.ok(INLINE_INTERPRETER_PATTERN.test('/usr/bin/env python3 -c "x"'));
    assert.ok(!INLINE_INTERPRETER_PATTERN.test('node -e "console.log(1)"'), 'node not covered by this pattern');
    assert.ok(!INLINE_INTERPRETER_PATTERN.test('python3 script.py'), 'script execution not inline');
    assert.ok(!INLINE_INTERPRETER_PATTERN.test('echo hello'), 'non-interpreter command');
  }); // interpreter pattern coverage: python2/3, ruby, perl, /usr/bin/env prefix

  it('INLINE_INTERPRETER_WRITES does not false-positive on open().read() followed by print with w (Fix 2)', () => {
    // open(.*['"]w is greedy — "open('.state.json').read(); print('w')" should NOT match
    // because the 'w' is in print(), not in open()'s mode argument
    assert.ok(
      !INLINE_INTERPRETER_WRITES.test("open('.state.json').read(); print('w')"),
      'greedy open() should not match w in print() after close-paren'
    );
  });

  it('INLINE_INTERPRETER_WRITES matches write operations', () => {
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','w')"), 'open with write mode');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','W')"), 'open with uppercase W mode');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','a')"), 'open with append mode');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','wb')"), 'open with binary write mode');
    assert.ok(INLINE_INTERPRETER_WRITES.test('File.write'));
    assert.ok(INLINE_INTERPRETER_WRITES.test('IO.write'));
    assert.ok(INLINE_INTERPRETER_WRITES.test('os.rename'));
    assert.ok(INLINE_INTERPRETER_WRITES.test('shutil.copy'));
    assert.ok(INLINE_INTERPRETER_WRITES.test('shutil.move'));
    assert.ok(!INLINE_INTERPRETER_WRITES.test('print("hello")'));
    assert.ok(!INLINE_INTERPRETER_WRITES.test("open('.state.json')"), 'read-only open() should NOT match');
    assert.ok(!INLINE_INTERPRETER_WRITES.test("open('.state.json').read()"), 'open().read() should NOT match');
    assert.ok(!INLINE_INTERPRETER_WRITES.test("open('.state.json','br')"), 'open with binary read mode should NOT match');
    assert.ok(!INLINE_INTERPRETER_WRITES.test("open('.state.json','rb')"), 'open with rb mode should NOT match');
    assert.ok(!INLINE_INTERPRETER_WRITES.test("open('.state.json','r')"), 'open with r mode should NOT match');
    assert.ok(!INLINE_INTERPRETER_WRITES.test("open('.state.json','b')"), 'open with bare binary mode should NOT match');

    // Write-capable modes added for Fix 2
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','x')"), 'open with exclusive create mode x');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','xb')"), 'open with exclusive binary create mode xb');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','r+')"), 'open with read+write mode r+');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','rb+')"), 'open with binary read+write mode rb+');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','w+')"), 'open with write+read mode w+');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','a+')"), 'open with append+read mode a+');
    assert.ok(INLINE_INTERPRETER_WRITES.test("open('.state.json','x+')"), 'open with exclusive create+read mode x+');
  });

  it('BASE64_EVASION_PATTERN matches base64 references', () => {
    assert.ok(BASE64_EVASION_PATTERN.test('base64'));
    assert.ok(BASE64_EVASION_PATTERN.test('b64decode'));
    assert.ok(BASE64_EVASION_PATTERN.test('b64encode'));
    assert.ok(BASE64_EVASION_PATTERN.test('atob'));
    assert.ok(BASE64_EVASION_PATTERN.test('btoa'));
    assert.ok(!BASE64_EVASION_PATTERN.test('print("hello")'));
  });

  it('BASE64_EVASION_PATTERN is case-insensitive (Fix 3)', () => {
    assert.ok(BASE64_EVASION_PATTERN.test('Base64'), 'mixed case Base64');
    assert.ok(BASE64_EVASION_PATTERN.test('BASE64'), 'uppercase BASE64');
    assert.ok(BASE64_EVASION_PATTERN.test('B64decode'), 'mixed case B64decode');
    assert.ok(BASE64_EVASION_PATTERN.test('B64ENCODE'), 'uppercase B64ENCODE');
    assert.ok(BASE64_EVASION_PATTERN.test('Atob'), 'mixed case Atob');
    assert.ok(BASE64_EVASION_PATTERN.test('BTOA'), 'uppercase BTOA');
  });
});

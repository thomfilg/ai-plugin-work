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
      command: 'perl -e "open(my $fh, \'.state.json\'); print $fh \'{}\'"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
    assert.equal(result.vector, 'Bash(perl -e)');
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

  it('blocks piped stdin python3 -c writing to protected file', () => {
    const result = protector.check('Bash', {
      command: 'echo "data" | python3 -c "import sys; open(\'.state.json\',\'w\').write(sys.stdin.read())"',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.state.json');
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
    assert.ok(!INLINE_INTERPRETER_PATTERN.test('node -e "console.log(1)"'));
    assert.ok(!INLINE_INTERPRETER_PATTERN.test('python3 script.py'));
  });

  it('INLINE_INTERPRETER_WRITES matches write operations', () => {
    assert.ok(INLINE_INTERPRETER_WRITES.test('open('));
    assert.ok(INLINE_INTERPRETER_WRITES.test('File.write'));
    assert.ok(INLINE_INTERPRETER_WRITES.test('IO.write'));
    assert.ok(INLINE_INTERPRETER_WRITES.test('os.rename'));
    assert.ok(INLINE_INTERPRETER_WRITES.test('shutil.copy'));
    assert.ok(INLINE_INTERPRETER_WRITES.test('shutil.move'));
    assert.ok(!INLINE_INTERPRETER_WRITES.test('print("hello")'));
  });

  it('BASE64_EVASION_PATTERN matches base64 references', () => {
    assert.ok(BASE64_EVASION_PATTERN.test('base64'));
    assert.ok(BASE64_EVASION_PATTERN.test('b64decode'));
    assert.ok(BASE64_EVASION_PATTERN.test('b64encode'));
    assert.ok(BASE64_EVASION_PATTERN.test('atob'));
    assert.ok(BASE64_EVASION_PATTERN.test('btoa'));
    assert.ok(!BASE64_EVASION_PATTERN.test('print("hello")'));
  });
});

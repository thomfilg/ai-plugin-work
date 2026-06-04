const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', 'bootstrap-custom-script.js');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-custom-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(args, env = {}) {
  const merged = { ...process.env, ...env };
  // Remove BOOTSTRAP_SCRIPT_TIMEOUT unless explicitly passed by the test
  if (!('BOOTSTRAP_SCRIPT_TIMEOUT' in env)) {
    delete merged.BOOTSTRAP_SCRIPT_TIMEOUT;
  }
  // Treat empty-string overrides as "unset" so tests can model the
  // "var truly absent" scenario without colliding with the outer
  // process.env. The production code distinguishes empty-string
  // (caller's explicit value, preserved) from undefined (eligible
  // for .envrc backfill).
  for (const [k, v] of Object.entries(env)) {
    if (v === '') delete merged[k];
  }
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: merged,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
  });
}

function runResult(args, env = {}) {
  try {
    const stdout = run(args, env);
    return { stdout, status: 0 };
  } catch (err) {
    return { stdout: err.stdout, stderr: err.stderr, status: err.status };
  }
}

function makeScript(name, content) {
  const scriptPath = path.join(tmpDir, name);
  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

describe('bootstrap-custom-script.js', () => {
  describe('argument validation', () => {
    it('exits 1 with no arguments', () => {
      const result = runResult([], { BOOTSTRAP_SCRIPT: '/some/script.sh' });
      assert.equal(result.status, 1);
    });

    it('exits 1 with only one argument', () => {
      const result = runResult(['/tmp'], { BOOTSTRAP_SCRIPT: '/some/script.sh' });
      assert.equal(result.status, 1);
    });
  });

  describe('BOOTSTRAP_SCRIPT unset', () => {
    it('exits 0 and logs skipping when BOOTSTRAP_SCRIPT is not set', () => {
      const output = run(['/tmp/worktree', 'TICKET-1'], { BOOTSTRAP_SCRIPT: '' });
      assert.match(output, /skipping/i);
    });
  });

  describe('non-existent script path', () => {
    it('exits 0 and logs warning when script path does not exist', () => {
      const output = run(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: '/nonexistent/path/to/script.sh',
      });
      assert.match(output, /not found|does not exist|warning/i);
    });
  });

  describe('successful script execution', () => {
    it('executes script with worktree-path and ticket-id as arguments', () => {
      const scriptPath = makeScript('echo-args.sh', '#!/bin/sh\necho "ARGS:$1:$2"\n');
      const output = run(['/tmp/worktree', 'TICKET-42'], {
        BOOTSTRAP_SCRIPT: scriptPath,
      });
      assert.match(output, /ARGS:\/tmp\/worktree:TICKET-42/);
    });

    it('exits 0 on successful execution', () => {
      const scriptPath = makeScript('ok.sh', '#!/bin/sh\nexit 0\n');
      const result = runResult(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: scriptPath,
      });
      assert.equal(result.status, 0);
    });
  });

  describe('script failure (fail-open)', () => {
    it('exits 0 when script exits non-zero', () => {
      const scriptPath = makeScript('fail.sh', '#!/bin/sh\necho "something broke" >&2\nexit 1\n');
      const result = runResult(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: scriptPath,
      });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /warning|failed|error/i);
    });
  });

  describe('timeout handling', () => {
    it('exits 0 when script exceeds timeout (fail-open)', () => {
      const scriptPath = makeScript('hang.sh', '#!/bin/sh\nwhile true; do sleep 1; done\n');
      const result = runResult(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: scriptPath,
        BOOTSTRAP_SCRIPT_TIMEOUT: '1',
      });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /timeout|timed out|warning/i);
    });
  });

  describe('relative path resolution', () => {
    it('resolves relative paths against cwd', () => {
      const scriptPath = makeScript('relative.sh', '#!/bin/sh\necho "RELATIVE_OK"\n');
      const relativePath = path.relative(process.cwd(), scriptPath);
      const output = run(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: relativePath,
      });
      assert.match(output, /RELATIVE_OK/);
    });
  });

  describe('stderr capture on success', () => {
    it('captures stderr output even when script exits 0', () => {
      const scriptPath = makeScript(
        'stderr-ok.sh',
        '#!/bin/sh\necho "stdout-line"\necho "stderr-warning" >&2\nexit 0\n'
      );
      const output = run(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: scriptPath,
      });
      assert.match(output, /stderr-warning/);
    });
  });

  describe('getTimeoutMs edge cases', () => {
    it('falls back to 120s for timeout value 0', () => {
      const scriptPath = makeScript('echo-ok.sh', '#!/bin/sh\necho "OK"\n');
      const result = runResult(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: scriptPath,
        BOOTSTRAP_SCRIPT_TIMEOUT: '0',
      });
      assert.equal(result.status, 0);
    });

    it('falls back to 120s for negative timeout value', () => {
      const scriptPath = makeScript('echo-ok2.sh', '#!/bin/sh\necho "OK"\n');
      const result = runResult(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: scriptPath,
        BOOTSTRAP_SCRIPT_TIMEOUT: '-5',
      });
      assert.equal(result.status, 0);
    });

    it('falls back to 120s for non-numeric timeout value', () => {
      const scriptPath = makeScript('echo-ok3.sh', '#!/bin/sh\necho "OK"\n');
      const result = runResult(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: scriptPath,
        BOOTSTRAP_SCRIPT_TIMEOUT: 'abc',
      });
      assert.equal(result.status, 0);
    });
  });

  describe('.envrc sourcing when BOOTSTRAP_SCRIPT not in env', () => {
    it('sources .envrc from worktree parent directory and runs the script', () => {
      const targetScript = makeScript('from-envrc.sh', '#!/bin/sh\necho "FROM_ENVRC_OK"\n');
      const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envrc-parent-'));
      const worktreeDir = path.join(parentDir, 'worktree-1');
      fs.mkdirSync(worktreeDir);
      fs.writeFileSync(
        path.join(parentDir, '.envrc'),
        `export BOOTSTRAP_SCRIPT="${targetScript}"\n`
      );

      try {
        const result = runResult([worktreeDir, 'TICKET-ENVRC'], { BOOTSTRAP_SCRIPT: '' });
        assert.equal(result.status, 0);
        assert.match(result.stdout, /Sourced \.envrc from/);
        assert.match(result.stdout, /FROM_ENVRC_OK/);
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    });

    it('process.env wins over .envrc value', () => {
      const envScript = makeScript('from-env.sh', '#!/bin/sh\necho "FROM_ENV_WINS"\n');
      const envrcScript = makeScript('from-envrc-loser.sh', '#!/bin/sh\necho "ENVRC_LOSER"\n');
      const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envrc-precedence-'));
      const worktreeDir = path.join(parentDir, 'worktree-1');
      fs.mkdirSync(worktreeDir);
      fs.writeFileSync(
        path.join(parentDir, '.envrc'),
        `export BOOTSTRAP_SCRIPT="${envrcScript}"\n`
      );

      try {
        const output = run([worktreeDir, 'TICKET-1'], { BOOTSTRAP_SCRIPT: envScript });
        assert.match(output, /FROM_ENV_WINS/);
        assert.doesNotMatch(output, /ENVRC_LOSER/);
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    });

    it('still logs skipping when no .envrc and no env var is set', () => {
      const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-envrc-'));
      const worktreeDir = path.join(parentDir, 'worktree-1');
      fs.mkdirSync(worktreeDir);

      try {
        const output = run([worktreeDir, 'TICKET-1'], { BOOTSTRAP_SCRIPT: '' });
        assert.match(output, /skipping/i);
      } finally {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    });
  });

  describe('non-executable file (EACCES)', () => {
    it('exits 0 and warns when file exists but is not executable', () => {
      const scriptPath = path.join(tmpDir, 'no-exec.sh');
      fs.writeFileSync(scriptPath, '#!/bin/sh\necho "should not run"\n', { mode: 0o644 });
      const result = runResult(['/tmp/worktree', 'TICKET-1'], {
        BOOTSTRAP_SCRIPT: scriptPath,
      });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /warning/i);
    });
  });
});

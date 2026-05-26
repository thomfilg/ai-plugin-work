/**
 * Tests for enforce-dev-commands.js (PreToolUse Bash hook)
 * Intercepts raw pnpm lint/test/typecheck commands and redirects to dev-check scripts.
 *
 * Run with: node --test workflows/lib/__tests__/enforce-dev-commands.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'enforce-dev-commands.js');
const FAKE_ROOT = '/fake/plugin/root';

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: FAKE_ROOT, ...env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

describe('enforce-dev-commands — BLOCK intercepted commands', () => {
  it('should BLOCK "pnpm lint"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm lint' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
    assert.ok(stderr.includes(FAKE_ROOT));
  });

  it('should BLOCK "pnpm run lint"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm run lint' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK "pnpm test"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm test' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK "pnpm run test"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm run test' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK "pnpm typecheck"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm typecheck' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK "pnpm run typecheck"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm run typecheck' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK "pnpm dev:lint"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm dev:lint' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK "pnpm dev:typecheck"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm dev:typecheck' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK "pnpm dev:test"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm dev:test' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK when intercepted command is part of a chain (&&)', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'cd /project && pnpm lint' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('dev-check.sh'));
  });

  it('should BLOCK "pnpm dev:check && pnpm lint" (chained with blocked command)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm dev:check && pnpm lint' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK when intercepted command follows a newline separator', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm dev:check\npnpm lint' },
    });
    assert.strictEqual(code, 2);
  });

  it('should ALLOW pnpm test with a file/pattern arg (scoped invocation)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm test path/foo.spec.ts' },
    });
    assert.strictEqual(code, 0);
  });

  it('should ALLOW pnpm test with a flag arg (-t pattern)', async () => {
    const { code } = await runHook({
      tool_input: { command: "pnpm test -t 'pattern'" },
    });
    assert.strictEqual(code, 0);
  });

  it('should ALLOW pnpm test --watch (any trailing arg means scoped/intentional)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm test --watch' },
    });
    assert.strictEqual(code, 0);
  });

  it('should BLOCK "pnpm --filter pkg lint" (pnpm flags before script)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm --filter pkg lint' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "pnpm -r lint" (short flag before script)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm -r lint' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "CI=1 pnpm test" (env var prefix)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'CI=1 pnpm test' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "env FOO=1 pnpm lint" (env command prefix)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'env FOO=1 pnpm lint' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "CI=1 NODE_ENV=test pnpm --filter=app typecheck" (multiple env + flag)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'CI=1 NODE_ENV=test pnpm --filter=app typecheck' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "pnpm --workspace-root dev:test" (long flag before dev: script)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm --workspace-root dev:test' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "pnpm run --filter pkg lint" (flags after run)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm run --filter pkg lint' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "pnpm run -r test" (short flag after run)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'pnpm run -r test' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "(pnpm test)" (subshell wrapper)', async () => {
    const { code } = await runHook({
      tool_input: { command: '(pnpm test)' },
    });
    assert.strictEqual(code, 2);
  });

  it('should ALLOW "bash -lc \"pnpm lint\"" (quotes are not treated as terminators to avoid false positives in grep patterns / strings)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'bash -lc "pnpm lint"' },
    });
    assert.strictEqual(code, 0);
  });

  it('should BLOCK "command pnpm test" (command builtin)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'command pnpm test' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "time pnpm lint" (time wrapper)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'time pnpm lint' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "/usr/bin/env pnpm test" (env path)', async () => {
    const { code } = await runHook({
      tool_input: { command: '/usr/bin/env pnpm test' },
    });
    assert.strictEqual(code, 2);
  });

  it('should BLOCK "cd /project & pnpm lint" (background operator)', async () => {
    const { code } = await runHook({
      tool_input: { command: 'cd /project & pnpm lint' },
    });
    assert.strictEqual(code, 2);
  });

  it('should include correct script path in stderr message', async () => {
    const { stderr } = await runHook({
      tool_input: { command: 'pnpm lint' },
    });
    const expectedPath = `${FAKE_ROOT}/workflows/lib/scripts/dev-check/dev-check.sh`;
    assert.ok(stderr.includes(expectedPath));
  });
});

describe('enforce-dev-commands — ALLOW non-intercepted commands', () => {
  it('should ALLOW "pnpm dev:check"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm dev:check' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW "git status"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'git status' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW unrelated commands', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'npm install express' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW commands with "lint" in different context', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'echo linting is done' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW "pnpm run dev:check"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm run dev:check' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW "CI=1 pnpm dev:check" (env prefix with allowed command)', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'CI=1 pnpm dev:check' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW "pnpm --filter pkg dev:check" (flags with allowed command)', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm --filter pkg dev:check' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW "pnpm format"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm format' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });

  it('should ALLOW "pnpm install"', async () => {
    const { code, stderr } = await runHook({
      tool_input: { command: 'pnpm install' },
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '');
  });
});

describe('enforce-dev-commands — fail-open behavior', () => {
  it('should ALLOW (exit 0) on malformed JSON input', async () => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: FAKE_ROOT },
    });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const result = await new Promise((resolve) => {
      proc.on('close', (code) => resolve({ code, stderr }));
      proc.stdin.write('not valid json {{{}');
      proc.stdin.end();
    });
    assert.strictEqual(result.code, 0);
  });

  it('should ALLOW (exit 0) on empty input', async () => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: FAKE_ROOT },
    });
    const result = await new Promise((resolve) => {
      proc.on('close', (code) => resolve({ code }));
      proc.stdin.end();
    });
    assert.strictEqual(result.code, 0);
  });

  it('should ALLOW (exit 0) when tool_input is missing', async () => {
    const { code } = await runHook({});
    assert.strictEqual(code, 0);
  });

  it('should ALLOW (exit 0) when command is missing', async () => {
    const { code } = await runHook({ tool_input: {} });
    assert.strictEqual(code, 0);
  });
});

describe('enforce-dev-commands — path resolution', () => {
  it('should use CLAUDE_PLUGIN_ROOT env var when set', async () => {
    const { stderr } = await runHook(
      { tool_input: { command: 'pnpm lint' } },
      { CLAUDE_PLUGIN_ROOT: '/custom/path' }
    );
    assert.ok(stderr.includes('/custom/path/workflows/lib/scripts/dev-check/dev-check.sh'));
  });

  it('should fallback to __dirname resolution when CLAUDE_PLUGIN_ROOT is not set', async () => {
    const expectedRoot = path.resolve(path.join(__dirname, '..', 'hooks'), '..', '..', '..');
    const { code, stderr } = await runHook(
      { tool_input: { command: 'pnpm lint' } },
      { CLAUDE_PLUGIN_ROOT: '' }
    );
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes(expectedRoot));
  });
});

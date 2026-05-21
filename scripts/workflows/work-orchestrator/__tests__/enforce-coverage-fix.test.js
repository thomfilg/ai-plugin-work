/**
 * Tests for enforce-coverage-fix.js hook (PostToolUse)
 * This hook outputs warnings to stdout, does not block (no exit 2).
 *
 * Run with: node --test hooks/__tests__/enforce-coverage-fix.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'enforce-coverage-fix.js');

function runHook(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
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

function createTranscript(entries) {
  const tmpFile = path.join(
    os.tmpdir(),
    `test-covfix-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  fs.writeFileSync(tmpFile, entries.map((e) => JSON.stringify(e)).join('\n'));
  return tmpFile;
}

describe('enforce-coverage-fix hook', () => {
  it('should exit 0 for non-Bash tools', async () => {
    const { code } = await runHook({ tool_name: 'Read', tool_input: {} });
    assert.strictEqual(code, 0);
  });

  it('should exit 0 for non-CI-check Bash commands', async () => {
    const { code } = await runHook({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    assert.strictEqual(code, 0);
  });

  it('should exit 0 for CI check command without coverage failure in transcript', async () => {
    const tp = createTranscript([{ type: 'tool_result', content: 'All checks passed' }]);
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh run view 123' },
      transcript_path: tp,
    });
    assert.strictEqual(code, 0);
  });

  it('should output warning when coverage failure detected in transcript', async () => {
    const tp = createTranscript([
      { type: 'tool_result', content: 'coverage decrease detected in modified files' },
    ]);
    const { code, stdout } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh run view 123' },
      transcript_path: tp,
    });
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes('COVERAGE FAILURE DETECTED'));
  });

  it('should detect gh pr checks command', async () => {
    const tp = createTranscript([
      { type: 'tool_result', content: 'check-coverage-decrease failed' },
    ]);
    const { stdout } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr checks 42' },
      transcript_path: tp,
    });
    assert.ok(stdout.includes('COVERAGE FAILURE DETECTED'));
  });

  it('should exit 0 when no transcript_path', async () => {
    const { code } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh run view 123' },
    });
    assert.strictEqual(code, 0);
  });
});

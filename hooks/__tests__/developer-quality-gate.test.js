/**
 * Tests for developer-quality-gate.js hook (SubagentStop)
 * Runs quality checks when developer agent finishes.
 * We can only test the parsing/exit behavior, not actual quality checks.
 *
 * Run with: node --test hooks/__tests__/developer-quality-gate.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'agents', 'developer-quality-gate.js');

function runHook(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ result: { decision: code === 2 ? 'block' : 'approve', reason: stderr.trim() || undefined }, stderr, code, stdout });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

describe('developer-quality-gate hook', () => {
  it('should BLOCK on invalid JSON (fail-fast)', async () => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const exitCode = await new Promise((resolve) => {
      proc.on('close', resolve);
      proc.stdin.write('not json');
      proc.stdin.end();
    });
    assert.strictEqual(exitCode, 2);
    assert.ok(stderr.includes('DEVELOPER QUALITY GATE: Failed to parse hook input'));
  });

  it('should handle hook input with agent name', async () => {
    // The hook runs quality checks if code changes exist.
    // In test context, git diff may return nothing or error.
    // Either way the hook should not crash.
    const { code } = await runHook({
      agent_name: 'developer-nodejs-tdd'
    });
    // Should exit 0 (approve) or 2 (block if checks fail)
    assert.ok([0, 2].includes(code));
  });
});

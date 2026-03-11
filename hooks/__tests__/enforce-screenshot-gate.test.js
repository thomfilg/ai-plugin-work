/**
 * Tests for enforce-screenshot-gate.js hook (PostToolUse)
 * Blocks /work-pr when TSX files changed without screenshots.
 *
 * Run with: node --test hooks/__tests__/enforce-screenshot-gate.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'enforce-screenshot-gate.js');

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

describe('enforce-screenshot-gate hook', () => {
  it('should APPROVE for non-Skill tools', async () => {
    const { result } = await runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE for non-work-pr skills', async () => {
    const { result } = await runHook({ tool_name: 'Skill', tool_input: { skill: 'work-implement' } });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when --force flag is passed', async () => {
    const { result } = await runHook({
      tool_name: 'Skill',
      tool_input: { skill: 'work-pr', args: 'PROJ-123 --force' }
    });
    assert.strictEqual(result.decision, 'approve');
  });

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
    assert.ok(stderr.includes('SCREENSHOT GATE: Failed to parse hook input'));
  });
});

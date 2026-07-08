/**
 * Tests for workflow-router-hook.js hook (UserPromptSubmit)
 * Uses CLAUDE_USER_PROMPT env var, not stdin.
 *
 * Run with: node --test hooks/__tests__/workflow-router-hook.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'workflow-router-hook.js');

function runHook(userPrompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_USER_PROMPT: userPrompt },
    });
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
    proc.stdin.end();
  });
}

describe('workflow-router-hook hook', () => {
  it('should exit 0 for non-workflow commands', async () => {
    const { code } = await runHook('hello how are you');
    assert.strictEqual(code, 0);
  });

  it('should exit 0 for empty prompt', async () => {
    const { code } = await runHook('');
    assert.strictEqual(code, 0);
  });

  it('should exit 0 when no workflows directory exists', async () => {
    const { code } = await runHook('/nonexistent-command PROJ-123');
    assert.strictEqual(code, 0);
  });
});

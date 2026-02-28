/**
 * Tests for enforce-work-command.js hook (PreToolUse)
 * Blocks Edit/Write when work-state exists but /work not active.
 *
 * Run with: node --test hooks/__tests__/enforce-work-command.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'enforce-work-command.js');

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

describe('enforce-work-command hook', () => {
  it('should APPROVE allowed file patterns (markdown)', async () => {
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/README.md' }
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE allowed file patterns (json)', async () => {
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/package.json' }
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE allowed file patterns (yaml)', async () => {
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/config.yml' }
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE .claude folder files', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/home/node/.claude/hooks/test.js' }
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE tasks folder files', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/home/node/worktrees/tasks/PROJ-123/notes.txt' }
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when /work is active in transcript', async () => {
    const tmpFile = path.join(os.tmpdir(), `test-work-cmd-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, '"skill" : "work"');
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tmpFile
    });
    assert.strictEqual(result.decision, 'approve');
  });
});

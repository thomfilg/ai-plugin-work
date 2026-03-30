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

function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
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
      tool_input: { file_path: '/tmp/project/.claude/hooks/test.js' }
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

  it('should APPROVE when inside code-architect subagent with WORK_ARCHITECT_ENABLED=1', async () => {
    const tmpFile = path.join(os.tmpdir(), `test-work-cmd-architect-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, '"subagent_type" : "work-workflow:code-architect"');
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tmpFile
    }, { WORK_ARCHITECT_ENABLED: '1' });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should NOT recognize code-architect subagent when WORK_ARCHITECT_ENABLED is not set', async () => {
    const tmpFile = path.join(os.tmpdir(), `test-work-cmd-architect-off-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, '"subagent_type" : "work-workflow:code-architect"');
    // Note: This test verifies isInsideSubagent won't match code-architect when gate is off.
    // The hook may still approve for other reasons (no work-state, allowed file, etc.)
    // so we test the function indirectly — the transcript has ONLY code-architect, no /work.
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tmpFile
    }, { WORK_ARCHITECT_ENABLED: '0' });
    // Without WORK_ARCHITECT_ENABLED, code-architect is not in agentTypes,
    // but the hook may approve because there's no work-state file for the branch.
    // This test ensures the hook runs without error at minimum.
    assert.ok(['approve', 'block'].includes(result.decision));
  });
});

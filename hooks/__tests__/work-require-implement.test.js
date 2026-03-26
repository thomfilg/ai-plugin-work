/**
 * Tests for work-require-implement.js hook (PreToolUse)
 *
 * Run with: node --test hooks/__tests__/work-require-implement.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'work-require-implement.js');

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

function runHookWithEnv(input, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
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

describe('work-require-implement hook', () => {
  it('should APPROVE non-blocked tools', async () => {
    const { result } = await runHook({ tool_name: 'Read', tool_input: {} });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE Write when /work is NOT active', async () => {
    const tp = path.join(os.tmpdir(), `test-wri-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, JSON.stringify({ message: { content: 'regular chat' } }));
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE allowed files (markdown)', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/home/node/project/README.md' }
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE task folder files', async () => {
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/home/node/worktrees/tasks/PROJ-123/plan.md' }
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should BLOCK code edits when /work active but no /work-implement', async () => {
    const tp = path.join(os.tmpdir(), `test-wri2-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, [
      '# Start Work Command',
      '/bootstrap PROJ-123',
      'Worktree created'
    ].join('\n'));
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.reason.includes('work-implement'));
  });

  it('should APPROVE when /work-implement has been invoked', async () => {
    const tp = path.join(os.tmpdir(), `test-wri3-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, [
      '# Start Work Command',
      '/bootstrap PROJ-123',
      'Worktree created',
      '# Implement Command'
    ].join('\n'));
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when inside developer agent', async () => {
    const tp = path.join(os.tmpdir(), `test-wri4-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, [
      '# Start Work Command',
      '/bootstrap PROJ-123',
      'Worktree created',
      '"subagent_type": "developer-nodejs-tdd"'
    ].join('\n'));
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when inside developer agent with work-workflow: prefix', async () => {
    const tp = path.join(os.tmpdir(), `test-wri-prefix-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, [
      '# Start Work Command',
      '/bootstrap PROJ-123',
      'Worktree created',
      '"subagent_type": "work-workflow:developer-nodejs-tdd"'
    ].join('\n'));
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when inside code-architect agent with work-workflow: prefix (with gate enabled)', async () => {
    const tp = path.join(os.tmpdir(), `test-wri-ca-prefix-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, [
      '# Start Work Command',
      '/bootstrap PROJ-123',
      'Worktree created',
      '"subagent_type": "work-workflow:code-architect"'
    ].join('\n'));
    const { result } = await runHookWithEnv({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    }, { WORK_ARCHITECT_ENABLED: '1' });
    assert.strictEqual(result.decision, 'approve');
  });

  describe('WORK_ARCHITECT_ENABLED gate', () => {
    it('should BLOCK code-architect when WORK_ARCHITECT_ENABLED is not set', async () => {
      const tp = path.join(os.tmpdir(), `test-wri-ca-gate-${Date.now()}.jsonl`);
      fs.writeFileSync(tp, [
        '# Start Work Command',
        '/bootstrap PROJ-123',
        'Worktree created',
        '"subagent_type": "code-architect"'
      ].join('\n'));
      const { result } = await runHookWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
        transcript_path: tp
      }, { WORK_ARCHITECT_ENABLED: '' });
      assert.strictEqual(result.decision, 'block');
    });

    it('should APPROVE code-architect when WORK_ARCHITECT_ENABLED=1', async () => {
      const tp = path.join(os.tmpdir(), `test-wri-ca-gate2-${Date.now()}.jsonl`);
      fs.writeFileSync(tp, [
        '# Start Work Command',
        '/bootstrap PROJ-123',
        'Worktree created',
        '"subagent_type": "code-architect"'
      ].join('\n'));
      const { result } = await runHookWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
        transcript_path: tp
      }, { WORK_ARCHITECT_ENABLED: '1' });
      assert.strictEqual(result.decision, 'approve');
    });
  });
});

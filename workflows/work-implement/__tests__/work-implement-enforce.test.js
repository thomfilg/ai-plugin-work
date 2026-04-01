/**
 * Tests for work-implement-enforce.js hook (PreToolUse)
 *
 * Run with: node --test hooks/__tests__/work-implement-enforce.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'work-implement-enforce.js');

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

describe('work-implement-enforce hook', () => {
  it('should APPROVE non-blocked tools (Read, Bash)', async () => {
    const { result } = await runHook({ tool_name: 'Read', tool_input: {} });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE Write when /work-implement is NOT active', async () => {
    const tp = path.join(os.tmpdir(), `test-wie-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, JSON.stringify({ message: { content: 'just regular chat' } }));
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE allowed files (markdown) even when /work-implement active', async () => {
    const tp = path.join(os.tmpdir(), `test-wie2-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, '# Implement Command\n');
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/home/node/project/README.md' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE .claude folder files', async () => {
    const tp = path.join(os.tmpdir(), `test-wie3-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, '# Implement Command\n');
    const { result } = await runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/project/.claude/hooks/test.js' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should BLOCK code edits when /work-implement active but no developer agent', async () => {
    const tp = path.join(os.tmpdir(), `test-wie4-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, '# Implement Command\n');
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.reason.includes('work-implement requires agent delegation'));
  });

  it('should APPROVE when developer agent has been invoked', async () => {
    const tp = path.join(os.tmpdir(), `test-wie5-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, '# Implement Command\n"subagent_type": "developer-nodejs-tdd"\n');
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when developer agent invoked with work-workflow: prefix', async () => {
    const tp = path.join(os.tmpdir(), `test-wie6-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, '# Implement Command\n"subagent_type": "work-workflow:developer-nodejs-tdd"\n');
    const { result } = await runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when code-architect agent has been invoked (with gate enabled)', async () => {
    const tp = path.join(os.tmpdir(), `test-wie-ca-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, '# Implement Command\n"subagent_type": "code-architect"\n');
    const { result } = await runHookWithEnv({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    }, { WORK_ARCHITECT_ENABLED: '1' });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when code-architect agent invoked with work-workflow: prefix (with gate enabled)', async () => {
    const tp = path.join(os.tmpdir(), `test-wie-ca2-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, '# Implement Command\n"subagent_type": "work-workflow:code-architect"\n');
    const { result } = await runHookWithEnv({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    }, { WORK_ARCHITECT_ENABLED: '1' });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should include code-architect in error message when blocking (with gate enabled)', async () => {
    const tp = path.join(os.tmpdir(), `test-wie-ca3-${Date.now()}.jsonl`);
    fs.writeFileSync(tp, '# Implement Command\n');
    const { result } = await runHookWithEnv({
      tool_name: 'Edit',
      tool_input: { file_path: '/home/node/project/src/app.ts' },
      transcript_path: tp
    }, { WORK_ARCHITECT_ENABLED: '1' });
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.reason.includes('code-architect'), 'error message should mention code-architect');
  });

  describe('WORK_ARCHITECT_ENABLED gate', () => {
    it('should BLOCK code-architect when WORK_ARCHITECT_ENABLED is not set', async () => {
      const tp = path.join(os.tmpdir(), `test-wie-gate-${Date.now()}.jsonl`);
      fs.writeFileSync(tp, '# Implement Command\n"subagent_type": "code-architect"\n');
      const { result } = await runHookWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
        transcript_path: tp
      }, { WORK_ARCHITECT_ENABLED: '' });
      assert.strictEqual(result.decision, 'block');
    });

    it('should APPROVE code-architect when WORK_ARCHITECT_ENABLED=1', async () => {
      const tp = path.join(os.tmpdir(), `test-wie-gate2-${Date.now()}.jsonl`);
      fs.writeFileSync(tp, '# Implement Command\n"subagent_type": "code-architect"\n');
      const { result } = await runHookWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
        transcript_path: tp
      }, { WORK_ARCHITECT_ENABLED: '1' });
      assert.strictEqual(result.decision, 'approve');
    });

    it('should NOT include code-architect in error message when WORK_ARCHITECT_ENABLED is not set', async () => {
      const tp = path.join(os.tmpdir(), `test-wie-gate3-${Date.now()}.jsonl`);
      fs.writeFileSync(tp, '# Implement Command\n');
      const { result } = await runHookWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
        transcript_path: tp
      }, { WORK_ARCHITECT_ENABLED: '' });
      assert.strictEqual(result.decision, 'block');
      assert.ok(!result.reason.includes('code-architect'), 'error message should NOT mention code-architect when disabled');
    });

    it('should include code-architect in error message when WORK_ARCHITECT_ENABLED=1', async () => {
      const tp = path.join(os.tmpdir(), `test-wie-gate4-${Date.now()}.jsonl`);
      fs.writeFileSync(tp, '# Implement Command\n');
      const { result } = await runHookWithEnv({
        tool_name: 'Edit',
        tool_input: { file_path: '/home/node/project/src/app.ts' },
        transcript_path: tp
      }, { WORK_ARCHITECT_ENABLED: '1' });
      assert.strictEqual(result.decision, 'block');
      assert.ok(result.reason.includes('code-architect'), 'error message should mention code-architect when enabled');
    });
  });

  it('should APPROVE on parse error (JSON.parse in main fails, main().catch fires)', async () => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exitCode = await new Promise((resolve) => {
      proc.on('close', resolve);
      proc.stdin.write('not json');
      proc.stdin.end();
    });
    // work-implement-enforce uses raw JSON.parse (no try/catch), so invalid JSON
    // throws and is caught by main().catch which exits 0 to avoid blocking
    assert.strictEqual(exitCode === 2 ? 'block' : 'approve', 'approve');
  });
});

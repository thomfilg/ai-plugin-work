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

const HOOK_PATH = path.join(__dirname, '..', 'work-implement-enforce.js');

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
      tool_input: { file_path: '/home/node/.claude/hooks/test.js' },
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

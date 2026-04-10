/**
 * Tests for enforce-completion-protocol.js hook (StopHook)
 *
 * Run with: node --test hooks/__tests__/enforce-completion-protocol.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'enforce-completion-protocol.js');

let GIT_ROOT;

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
      resolve({
        result: { decision: code === 2 ? 'block' : 'approve', reason: stderr.trim() || undefined },
        stderr,
        code,
        stdout,
      });
    });
    proc.on('error', reject);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

function createTranscript(entries) {
  const tmpFile = path.join(
    os.tmpdir(),
    `test-completion-tx-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  fs.writeFileSync(tmpFile, entries.map((e) => JSON.stringify(e)).join('\n'));
  return tmpFile;
}

describe('enforce-completion-protocol hook', () => {
  before(() => {
    GIT_ROOT = path.join(os.tmpdir(), `test-completion-${process.pid}-${Date.now()}`);
    fs.mkdirSync(path.join(GIT_ROOT, 'apps', 'as-dashboard-worker', 'src'), { recursive: true });
    fs.mkdirSync(path.join(GIT_ROOT, 'docs'), { recursive: true });
    execSync('git init', { cwd: GIT_ROOT, stdio: 'pipe' });
    fs.writeFileSync(path.join(GIT_ROOT, 'apps', 'as-dashboard-worker', 'src', 'index.ts'), '');
    fs.writeFileSync(path.join(GIT_ROOT, 'docs', 'guide.md'), '');
  });

  after(() => {
    fs.rmSync(GIT_ROOT, { recursive: true, force: true });
  });

  it('should APPROVE when stop_hook_active is true', async () => {
    const { result } = await runHook({ stop_hook_active: true });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE on invalid JSON input', async () => {
    const proc = spawn('node', [HOOK_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exitCode = await new Promise((resolve) => {
      proc.on('close', resolve);
      proc.stdin.write('not json');
      proc.stdin.end();
    });
    assert.strictEqual(exitCode === 2 ? 'block' : 'approve', 'approve');
  });

  it('should APPROVE when no completion language in message', async () => {
    const tp = createTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: `${GIT_ROOT}/apps/as-dashboard-worker/src/index.ts` },
            },
          ],
        },
      },
    ]);
    const { result } = await runHook({
      transcript_path: tp,
      assistant_message: { content: 'Let me now run the tests to verify.' },
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE ongoing work phrases even with completion-like words', async () => {
    const tp = createTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: `${GIT_ROOT}/apps/as-dashboard-worker/src/index.ts` },
            },
          ],
        },
      },
    ]);
    const { result } = await runHook({
      transcript_path: tp,
      assistant_message: { content: 'Let me now run the tests to check if this is complete.' },
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE when no transcript_path provided', async () => {
    const { result } = await runHook({
      assistant_message: { content: 'The task is complete.' },
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should BLOCK completion declaration without required checks for code files', async () => {
    const tp = createTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: `${GIT_ROOT}/apps/as-dashboard-worker/src/index.ts` },
            },
          ],
        },
      },
    ]);
    const { result } = await runHook({
      transcript_path: tp,
      assistant_message: { content: 'The implementation is complete.' },
    });
    assert.strictEqual(result.decision, 'block');
    assert.ok(result.reason.includes('Completion Protocol'));
  });

  it('should APPROVE completion when all checks are done for code files', async () => {
    const tp = createTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: `${GIT_ROOT}/apps/as-dashboard-worker/src/index.ts` },
            },
            { type: 'tool_use', name: 'Bash', input: { command: 'pnpm lint' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'pnpm typecheck' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
            { type: 'tool_use', name: 'Task', input: { subagent_type: 'requirements-verifier' } },
          ],
        },
      },
    ]);
    const { result } = await runHook({
      transcript_path: tp,
      assistant_message: { content: 'The task is complete.' },
    });
    assert.strictEqual(result.decision, 'approve');
  });

  it('should APPROVE completion for docs-only changes with verifier', async () => {
    const tp = createTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: `${GIT_ROOT}/docs/guide.md` } },
            { type: 'tool_use', name: 'Task', input: { subagent_type: 'requirements-verifier' } },
          ],
        },
      },
    ]);
    const { result } = await runHook({
      transcript_path: tp,
      assistant_message: { content: 'The documentation is complete.' },
    });
    assert.strictEqual(result.decision, 'approve');
  });
});

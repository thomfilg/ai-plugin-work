/**
 * Task 7 — Wiring: OnPreToolCall (work-hook.js) + OnPostToolCall (work-auto-advance.js).
 *
 * Asserts:
 *   - `hooks/work-hook.js` exposes a `firePreToolCall` helper that dispatches
 *     `OnPreToolCall` with `{toolName, toolInput}` after the existing hook body,
 *     gated on `findActiveMarker` returning truthy.
 *   - `hooks/work-auto-advance.js` exposes a `firePostToolCall` helper that
 *     dispatches `OnPostToolCall` with `{toolName, toolInput, toolResult}` before
 *     the existing auto-advance logic, gated on `findActiveMarker` truthy.
 *   - Errors thrown inside dispatch never crash the hook (caller observes no throw).
 *   - When `findActiveMarker` returns null, no dispatch occurs.
 *
 * The hook files invoke `main()` at module load (PreToolUse / PostToolUse entry
 * points). To exercise their exported helpers without triggering `main()`, the
 * tests load each helper inside a child process that requires the file under
 * an environment flag both hooks honour to short-circuit `main()` early.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRE_HOOK_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'hooks',
  'work-hook.js'
);
const POST_HOOK_PATH = path.resolve(__dirname, '..', '..', '..', 'hooks', 'work-auto-advance.js');

/**
 * Run a small inline node script in a child process that requires the hook
 * file, calls the exported helper with deps captured in JSON, and prints the
 * captured calls array as JSON on stdout. The child sets WORK_HOOK_NO_MAIN=1 so
 * the hook's `main()` becomes a no-op when required as a library.
 *
 * @param {string} hookPath
 * @param {string} helperName
 * @param {object} args
 * @param {{markerReturns: 'truthy'|'null', dispatchThrows?: boolean}} dispatchOpts
 * @returns {{exitCode: number, stdoutJson: any, stderr: string}}
 */
function runHelperInChild(hookPath, helperName, args, dispatchOpts) {
  const script = `
    'use strict';
    const mod = require(${JSON.stringify(hookPath)});
    if (typeof mod[${JSON.stringify(helperName)}] !== 'function') {
      console.error('MISSING_EXPORT');
      process.exit(7);
    }
    const calls = [];
    const deps = {
      findActiveMarker: () => (${JSON.stringify(dispatchOpts.markerReturns)} === 'truthy'
        ? { ticket: 'GH-522' }
        : null),
      initExtensions: ({ repoRoot, tasksDir }) => ({
        dispatch: (event, payload) => {
          if (${JSON.stringify(!!dispatchOpts.dispatchThrows)}) throw new Error('boom');
          calls.push({ event, payload, repoRoot, tasksDir });
        },
        status: () => [],
      }),
    };
    let threw = false;
    try {
      mod[${JSON.stringify(helperName)}](${JSON.stringify(args)}, deps);
    } catch (e) {
      threw = true;
    }
    process.stdout.write(JSON.stringify({ calls, threw }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, WORK_HOOK_NO_MAIN: '1' },
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return { exitCode: result.status, stdoutJson: parsed, stderr: result.stderr };
}

describe('work-hook.js — OnPreToolCall wiring (Task 7)', () => {
  it('exports firePreToolCall helper', () => {
    const out = runHelperInChild(
      PRE_HOOK_PATH,
      'firePreToolCall',
      {
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy' }
    );
    assert.notEqual(out.exitCode, 7, 'firePreToolCall must be exported');
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson, 'expected JSON payload from child');
  });

  it('dispatches OnPreToolCall with {toolName, toolInput} when marker is active', () => {
    const out = runHelperInChild(
      PRE_HOOK_PATH,
      'firePreToolCall',
      {
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy' }
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.calls.length, 1);
    assert.equal(out.stdoutJson.calls[0].event, 'OnPreToolCall');
    assert.deepEqual(out.stdoutJson.calls[0].payload, {
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
  });

  it('does not dispatch OnPreToolCall when findActiveMarker returns null', () => {
    const out = runHelperInChild(
      PRE_HOOK_PATH,
      'firePreToolCall',
      {
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'null' }
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.calls.length, 0);
  });

  it('never crashes when dispatch throws (OnPreToolCall)', () => {
    const out = runHelperInChild(
      PRE_HOOK_PATH,
      'firePreToolCall',
      {
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy', dispatchThrows: true }
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.threw, false, 'firePreToolCall must not propagate dispatch errors');
  });
});

describe('work-auto-advance.js — OnPostToolCall wiring (Task 7)', () => {
  it('exports firePostToolCall helper', () => {
    const out = runHelperInChild(
      POST_HOOK_PATH,
      'firePostToolCall',
      {
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolResult: { stdout: '', exitCode: 0 },
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy' }
    );
    assert.notEqual(out.exitCode, 7, 'firePostToolCall must be exported');
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
  });

  it('dispatches OnPostToolCall with {toolName, toolInput, toolResult} when marker is active', () => {
    const out = runHelperInChild(
      POST_HOOK_PATH,
      'firePostToolCall',
      {
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolResult: { stdout: 'a\nb\n', exitCode: 0 },
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy' }
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.calls.length, 1);
    assert.equal(out.stdoutJson.calls[0].event, 'OnPostToolCall');
    assert.deepEqual(out.stdoutJson.calls[0].payload, {
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResult: { stdout: 'a\nb\n', exitCode: 0 },
    });
  });

  it('does not dispatch OnPostToolCall when findActiveMarker returns null', () => {
    const out = runHelperInChild(
      POST_HOOK_PATH,
      'firePostToolCall',
      {
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolResult: { stdout: '', exitCode: 0 },
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'null' }
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(out.stdoutJson.calls.length, 0);
  });

  it('never crashes when dispatch throws (OnPostToolCall)', () => {
    const out = runHelperInChild(
      POST_HOOK_PATH,
      'firePostToolCall',
      {
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        toolResult: { stdout: '', exitCode: 0 },
        tasksDir: '/tmp/tasks/GH-522',
        repoRoot: '/tmp/repo',
      },
      { markerReturns: 'truthy', dispatchThrows: true }
    );
    assert.equal(out.exitCode, 0, `child failed: ${out.stderr}`);
    assert.ok(out.stdoutJson);
    assert.equal(
      out.stdoutJson.threw,
      false,
      'firePostToolCall must not propagate dispatch errors'
    );
  });
});

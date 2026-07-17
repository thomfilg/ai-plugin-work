'use strict';

/**
 * codex payload-replay corpus (GH-774) — proves the migrated work-workflow
 * hooks satisfy the codex response contract when fed recorded codex-shaped
 * payloads with NO CLAUDE_HOOK_TYPE env:
 *   - Stop            → session-guard.js
 *   - PreToolUse      → enforce-step-workflow.js
 *   - PostToolUse     → enforce-step-workflow.js
 *   - UserPromptSubmit→ a runHook-based probe (contract-level coverage of the
 *     wrapper's JSON-response discipline; no UPS work-hook is migrated here)
 *
 * Each hook is replayed from a throwaway cwd so there is no active workflow
 * state — the fail-open path — and must exit 0 with schema-valid-or-empty
 * stdout, within the ~2s codex budget. A guard test proves the corpus itself
 * would have caught the session-guard Stop crash (exit 1) before the fix.
 *
 * Run: node --test plugins/work/scripts/workflows/lib/hooks/__tests__/codex-replay/codex-replay.spec.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadFixture, replay, assertContract } = require('./replay');

const HOOKS_DIR = path.resolve(__dirname, '..', '..');
const SESSION_GUARD = path.join(HOOKS_DIR, 'session-guard.js');
const ENFORCE_STEP = path.join(HOOKS_DIR, 'enforce-step-workflow.js');

let tmpCwd;
let errLog;

before(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-replay-'));
  errLog = path.join(tmpCwd, 'hook-errors.log');
});
after(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function env() {
  // Isolate config resolution to the throwaway tree; keep the guard silent.
  return {
    HOOK_ERROR_LOG: errLog,
    WORKTREES_BASE: tmpCwd,
    TASKS_BASE: path.join(tmpCwd, 'tasks'),
    SESSION_GUARD_ENABLED: '1',
  };
}

describe('codex payload-replay corpus', () => {
  it('Stop → session-guard.js exits 0 with empty output (no active session)', () => {
    const result = replay(SESSION_GUARD, loadFixture('stop'), { cwd: tmpCwd, env: env() });
    assertContract(result, { event: 'Stop', codes: [0] });
    assert.equal(result.stdout, '');
  });

  it('PreToolUse → enforce-step-workflow.js exits 0, schema-valid-or-empty stdout', () => {
    const result = replay(ENFORCE_STEP, loadFixture('pre-tool-use'), { cwd: tmpCwd, env: env() });
    assertContract(result, { event: 'PreToolUse', codes: [0] });
  });

  it('PostToolUse → enforce-step-workflow.js exits 0 within the codex latency budget', () => {
    const result = replay(ENFORCE_STEP, loadFixture('post-tool-use'), { cwd: tmpCwd, env: env() });
    assertContract(result, { event: 'PostToolUse', codes: [0] });
  });

  it('UserPromptSubmit → a runHook probe emits only valid JSON on stdout', () => {
    const runtimeIndex = require.resolve(path.join(HOOKS_DIR, '..', 'runtime', 'run-hook'));
    const probe = path.join(tmpCwd, 'ups-probe.js');
    fs.writeFileSync(
      probe,
      [
        "'use strict';",
        `const { runHook } = require(${JSON.stringify(runtimeIndex)});`,
        'runHook(({ rt, event }) => {',
        '  rt.emit.context(event, "workflow reminder");',
        '});',
        '',
      ].join('\n')
    );
    const result = replay(probe, loadFixture('user-prompt-submit'), { cwd: tmpCwd, env: env() });
    assertContract(result, { event: 'UserPromptSubmit', codes: [0] });
  });
});

describe('corpus self-check (regression net)', () => {
  it('would have caught the session-guard Stop crash: a CLI-branch fallthrough exits non-zero', () => {
    // Reproduce the pre-fix failure mode: a hook that keys hook-mode off
    // CLAUDE_HOOK_TYPE alone falls through to a CLI usage error (exit 1) on a
    // codex Stop payload. The contract assertion must reject it.
    const bad = path.join(tmpCwd, 'bad-stop-hook.js');
    fs.writeFileSync(
      bad,
      [
        "'use strict';",
        'if (!process.env.CLAUDE_HOOK_TYPE) {',
        '  process.stderr.write("Usage: ...\\n");',
        '  process.exit(1);',
        '}',
        '',
      ].join('\n')
    );
    const result = replay(bad, loadFixture('stop'), { cwd: tmpCwd, env: env() });
    assert.throws(() => assertContract(result, { event: 'Stop', codes: [0] }));
  });
});

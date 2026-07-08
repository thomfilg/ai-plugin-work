'use strict';

/**
 * Dual-runtime tests for work-hook.js (WP-06).
 *
 * Prompt source: CLAUDE_USER_PROMPT env leg stays first (claude byte
 * identity), stdin payload.prompt is the codex leg (codex sets no CLAUDE_*
 * vars). The /^\s*\/work\s+/i match doubles as the in-code self-filter on
 * codex, where UserPromptSubmit matchers are ignored and the hook fires on
 * every prompt. Plan stdout is pinned against a HEAD characterization
 * fixture (UserPromptSubmit plain stdout is injected on BOTH runtimes).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', '..', 'hooks', 'work-hook.js');
const FIXTURE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'runtime',
  'claude',
  'work-hook-plan.out.txt'
);

// Deterministic orchestrator stub — mirrors the plan the HEAD fixture was
// captured with. Ticket starts with TBD so appendAction is skipped.
const STUB_PLAN = {
  ticket: 'TBD-CHAR',
  mode: 'new',
  currentStep: 'ticket',
  state: { worktreeExists: false, hasDiffVsMain: false, hasUncommitted: false },
  plan: [
    { step: 'ticket', action: 'RUN', reason: 'start', command: 'node work-next.js' },
    { step: 'brief', action: 'SKIP', reason: 'disabled' },
    { step: 'implement', action: 'DEFER', reason: 'later' },
  ],
  summary: {
    run: 1,
    skip: 1,
    defer: 1,
    pending: 0,
    firstAction: 'ticket',
    stepsToRun: ['ticket'],
    stepsDeferred: ['implement'],
  },
};

describe('work-hook — dual runtime', () => {
  let fakeRoot;
  let expected;

  before(() => {
    fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'work-hook-rt-'));
    const engineDir = path.join(fakeRoot, 'scripts', 'workflows', 'work', 'engine');
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(
      path.join(engineDir, 'work.workflow.js'),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(STUB_PLAN))});\n`
    );
    expected = fs.readFileSync(FIXTURE, 'utf8').split('__PLUGIN_ROOT__').join(fakeRoot);
  });

  after(() => {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  });

  function runHook(stdin, env = {}) {
    const merged = { ...process.env, CLAUDE_PLUGIN_ROOT: fakeRoot, ...env };
    for (const key of [
      'AGENT_RUNTIME',
      'AGENT_SESSION_ID',
      'CODEX_THREAD_ID',
      'PLUGIN_ROOT',
      'CLAUDE_USER_PROMPT',
    ]) {
      if (!(key in env)) delete merged[key];
    }
    const r = spawnSync(process.execPath, [HOOK], {
      input: stdin,
      encoding: 'utf8',
      timeout: 35000,
      env: merged,
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  it('claude env leg: plan stdout byte-identical to the HEAD fixture', () => {
    const r = runHook('', { AGENT_RUNTIME: 'claude', CLAUDE_USER_PROMPT: '/work GH-999' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, expected);
  });

  it('claude payload leg: payload.prompt works when the env var is absent', () => {
    const r = runHook(JSON.stringify({ prompt: '/work GH-999', session_id: 'sess-1' }), {
      AGENT_RUNTIME: 'claude',
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, expected);
  });

  it('codex: payload.prompt drives the same plan injection (UPS stdout is valid there)', () => {
    const r = runHook(
      JSON.stringify({
        prompt: '/work GH-999',
        session_id: 'sess-1',
        turn_id: 't-1',
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
      }),
      { AGENT_RUNTIME: 'codex' }
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, expected);
  });

  it('self-filter: non-/work prompts are silent (codex fires on every prompt)', () => {
    for (const prompt of ['fix the bug', 'work on this please', '/work-implement GH-1']) {
      const r = runHook(JSON.stringify({ prompt, session_id: 'sess-1', turn_id: 't-1' }), {
        AGENT_RUNTIME: 'codex',
      });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '', `prompt ${JSON.stringify(prompt)} must not trigger`);
    }
  });

  it('env leg stays first: env prompt wins over payload.prompt', () => {
    const r = runHook(JSON.stringify({ prompt: '/work GH-111' }), {
      AGENT_RUNTIME: 'claude',
      CLAUDE_USER_PROMPT: 'not a work invocation',
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'env leg is authoritative when set');
  });
});

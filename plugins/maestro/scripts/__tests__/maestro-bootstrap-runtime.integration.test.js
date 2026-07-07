// WP-09 — bootstrap `--runtime=` flag, `.maestro-runtime` persistence, and
// the codex launch line (exec --json + BOTH bypass flags + teed stream +
// skill-mention prompt + no /rename grooming). Claude default stays
// bit-for-bit (`$CLAUDE_BIN --dangerously-skip-permissions '/work <T>'`).
//
// Harness mirrors maestro-bootstrap-skill.integration.test.js: hermetic
// WORKTREES_BASE with a fake `<REPO>/.git`, sandbox cwd with no ../.envrc,
// stub tmux/git/node on PATH (fixtures/), new-session argv captured.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runScript } = require('./helpers.js');

const BOOTSTRAP_SH = path.resolve(__dirname, '..', 'maestro-bootstrap.sh');
const REPO_NAME = 'claude-plugin-work';

function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-wt-'));
  fs.mkdirSync(path.join(base, REPO_NAME, '.git'), { recursive: true });
  fs.mkdirSync(path.join(base, 'tasks'), { recursive: true });
  const sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-cwd-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-home-'));
  const wrapper = path.join(base, 'run-bootstrap.sh');
  fs.writeFileSync(
    wrapper,
    [
      '#!/usr/bin/env bash',
      `cd "${sandboxCwd}" || exit 1`,
      `exec bash "${BOOTSTRAP_SH}" "$@"`,
    ].join('\n') + '\n'
  );
  return { wrapper, base, fakeHome };
}

function baseEnv(base, fakeHome, extra = {}) {
  return {
    WORKTREES_BASE: base,
    REPO_NAME,
    HOME: fakeHome,
    FAKE_TMUX_HAS_SESSION: '1', // absent → bootstrap reaches new-session
    FAKE_NODE_MODE: 'projectKey',
    FAKE_NODE_PROJECT_KEY: '',
    TASKS_BASE: path.join(base, 'tasks'),
    STATE_DIR: path.join(base, 'state'),
    ...extra,
  };
}

const RUN_OPTS = { timeout: 30000 };

test('--runtime=codex writes .maestro-runtime and launches codex exec --json with both bypass flags', () => {
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticket = 'GH-9301';

  const r = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--runtime=codex', ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(r.status, 0, `bootstrap: ${r.stdout}\n${r.stderr}`);

  const runtimeFile = path.join(base, 'tasks', ticket, '.maestro-runtime');
  assert.equal(fs.readFileSync(runtimeFile, 'utf8').trim(), 'codex');

  const argv = r.newSessionCalls.join('\n');
  assert.match(argv, /AGENT_RUNTIME=codex/, `launch must pin AGENT_RUNTIME; got:\n${argv}`);
  assert.match(argv, /codex exec --json/);
  // C9: hook-trust bypass is mandatory or the /work enforcement layer is
  // silently OFF (GT §2.8.2); sandbox bypass is required for state writes.
  assert.match(argv, /--dangerously-bypass-hook-trust/);
  assert.match(argv, /--dangerously-bypass-approvals-and-sandbox/);
  // Skill-mention prompt (no /slash surface on codex) + teed stream.
  assert.match(argv, /Use the work skill for GH-9301/);
  assert.match(argv, /tee -a '.*GH-9301\.exec\.jsonl'/);
  assert.match(argv, /<\/dev\/null/);
  // No claude launcher fragments.
  assert.doesNotMatch(argv, /--dangerously-skip-permissions/);
  assert.doesNotMatch(argv, /'\/work GH-9301'/);
});

test('default launch stays claude bit-for-bit and writes .maestro-runtime = claude', () => {
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticket = 'GH-9302';

  const r = runScript(wrapper, {
    ...RUN_OPTS,
    args: [ticket],
    env: baseEnv(base, fakeHome, { CLAUDE_BIN: 'fake-claude' }),
  });
  assert.equal(r.status, 0, `bootstrap: ${r.stdout}\n${r.stderr}`);

  const runtimeFile = path.join(base, 'tasks', ticket, '.maestro-runtime');
  assert.equal(fs.readFileSync(runtimeFile, 'utf8').trim(), 'claude');

  const argv = r.newSessionCalls.join('\n');
  assert.match(argv, /fake-claude --dangerously-skip-permissions '\/work GH-9302'/);
  assert.doesNotMatch(argv, /AGENT_RUNTIME=codex|codex exec|bypass-hook-trust/);
});

test('bare re-bootstrap preserves a persisted codex runtime (no silent claude relaunch)', () => {
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticket = 'GH-9303';

  const seed = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--runtime=codex', ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(seed.status, 0, `seed: ${seed.stdout}\n${seed.stderr}`);

  const rerun = runScript(wrapper, {
    ...RUN_OPTS,
    args: [ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(rerun.status, 0, `re-run: ${rerun.stdout}\n${rerun.stderr}`);

  const runtimeFile = path.join(base, 'tasks', ticket, '.maestro-runtime');
  assert.equal(fs.readFileSync(runtimeFile, 'utf8').trim(), 'codex', 'runtime preserved');
  const argv = rerun.newSessionCalls.join('\n');
  assert.match(argv, /codex exec --json/, `re-launch must stay codex; got:\n${argv}`);
  assert.doesNotMatch(argv, /--dangerously-skip-permissions/);
});

test('unknown --runtime value warns on stderr and falls open to claude', () => {
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticket = 'GH-9304';

  const r = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--runtime=gpt6', ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(r.status, 0, `bootstrap: ${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /unknown runtime 'gpt6'/);
  const runtimeFile = path.join(base, 'tasks', ticket, '.maestro-runtime');
  assert.equal(fs.readFileSync(runtimeFile, 'utf8').trim(), 'claude');
  const argv = r.newSessionCalls.join('\n');
  assert.match(argv, /--dangerously-skip-permissions '\/work GH-9304'/);
  assert.doesNotMatch(argv, /codex exec/);
});

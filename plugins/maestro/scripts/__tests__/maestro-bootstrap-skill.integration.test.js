// Integration tests for Task 2 (GH-514): bootstrap `--skill` flag,
// `MAESTRO_SKILL` env, `.maestro-skill` write, and `.work-state.json`
// stub-skip gate when target skill ≠ `work`.
//
// Strategy:
//   * Stand up a throwaway WORKTREES_BASE with a fake `<REPO_NAME>/.git` so
//     bootstrap's repo guard passes.
//   * Create a sandbox cwd with no `.envrc` so bootstrap's `$PWD/../.envrc`
//     lookup is a no-op (the real repo's .envrc never leaks in).
//   * Inject a fake `bootstrap-custom-script.js` BOOTSTRAP_HELPER into one of
//     the candidate paths the script searches (a `~/.claude/plugins/cache/...`
//     subdir under a sandbox HOME). The fake helper writes
//     `tasks/<ticket>/.work-state.json` mimicking the production helper.
//   * The fake `tmux` stub records `new-session` argv so we can assert the
//     launcher form (`/work` vs `/follow-up`).
//
// Acceptance criteria (from tasks.md §1.2.1):
//   (a) `--skill=follow-up GH-9001` ⇒ `.maestro-skill` contains `follow-up`,
//        `.work-state.json` does NOT exist.
//   (b) `--skill=follow-up GH-9001` ⇒ tmux new-session argv contains
//        `/follow-up GH-9001`.
//   (c) No `--skill`, no env ⇒ `.work-state.json` IS written and
//        new-session argv contains `/work GH-9001`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { runScript } = require('./helpers.js');

const BOOTSTRAP_SH = path.resolve(__dirname, '..', 'maestro-bootstrap.sh');
const REPO_NAME = 'claude-plugin-work';

/**
 * Build a hermetic bootstrap sandbox:
 *   - `<base>/<REPO_NAME>/.git` so the repo guard passes.
 *   - `<base>/tasks/` so the script can write `.maestro-skill` and so the
 *     fake helper can write `.work-state.json`.
 *   - A sandbox cwd with no `.envrc` above it.
 *   - A fake HOME containing a `bootstrap-custom-script.js` stub at one of
 *     the candidate paths the script globs.
 *   - A wrapper that `cd`s into the sandbox cwd before exec'ing bootstrap.
 *
 * @returns {{wrapper:string, base:string, fakeHome:string, tasksDir:string, helperLog:string}}
 */
function makeSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-skill-wt-'));
  fs.mkdirSync(path.join(base, REPO_NAME, '.git'), { recursive: true });
  const tasksDir = path.join(base, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-skill-cwd-'));

  // Fake HOME with a bootstrap-custom-script.js helper at the cache glob path
  // the script searches (`~/.claude/plugins/cache/work-workflow/work-workflow/*/scripts/workflows/work/scripts/bootstrap-custom-script.js`).
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-skill-home-'));
  const helperDir = path.join(
    fakeHome,
    '.claude/plugins/cache/work-workflow/work-workflow/9.9.9/scripts/workflows/work/scripts'
  );
  fs.mkdirSync(helperDir, { recursive: true });
  const helperPath = path.join(helperDir, 'bootstrap-custom-script.js');
  const helperLog = path.join(base, 'helper-calls.log');
  // The fake helper writes a `.work-state.json` into `<base>/tasks/<ticket>/`
  // and appends its argv to a log. Args: <worktree-path> <ticket-id>.
  fs.writeFileSync(
    helperPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      'const [wt, ticket] = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(helperLog)}, JSON.stringify({ wt, ticket }) + '\\n');`,
      `const tasksDir = path.join(${JSON.stringify(base)}, 'tasks', ticket);`,
      'fs.mkdirSync(tasksDir, { recursive: true });',
      "fs.writeFileSync(path.join(tasksDir, '.work-state.json'), JSON.stringify({ phase: 'bootstrap' }));",
    ].join('\n') + '\n'
  );
  fs.chmodSync(helperPath, 0o755);

  const wrapper = path.join(base, 'run-bootstrap.sh');
  fs.writeFileSync(
    wrapper,
    [
      '#!/usr/bin/env bash',
      `cd "${sandboxCwd}" || exit 1`,
      `exec bash "${BOOTSTRAP_SH}" "$@"`,
    ].join('\n') + '\n'
  );

  return { wrapper, base, fakeHome, tasksDir, helperLog };
}

function baseEnv(base, fakeHome, extra = {}) {
  return {
    WORKTREES_BASE: base,
    REPO_NAME,
    HOME: fakeHome,
    // FAKE_TMUX_HAS_SESSION other than "0" means "session absent" so the
    // script falls through to new-session (which we want to assert on).
    FAKE_TMUX_HAS_SESSION: '1',
    // No provider env → default GH prefix; we always pass fully-qualified
    // tickets so normalization is a no-op.
    FAKE_NODE_MODE: 'projectKey',
    FAKE_NODE_PROJECT_KEY: '',
    // MAESTRO_TASKS_BASE: tells bootstrap where to write the per-ticket file.
    // The script must honor this; if it doesn't, the test will fail because
    // `.maestro-skill` won't land where we look for it.
    MAESTRO_TASKS_BASE: path.join(base, 'tasks'),
    ...extra,
  };
}

const RUN_OPTS = { timeout: 30000 };

test('Bootstrap with --skill=follow-up writes .maestro-skill and skips .work-state.json stub', () => {
  const { wrapper, base, fakeHome, helperLog } = makeSandbox();
  const ticket = 'GH-9001';

  const { stdout, stderr, status, newSessionCalls } = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--skill=follow-up', ticket],
    env: baseEnv(base, fakeHome),
  });

  assert.equal(
    status,
    0,
    `bootstrap should exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );

  // (a) .maestro-skill written with the resolved skill.
  const skillFile = path.join(base, 'tasks', ticket, '.maestro-skill');
  assert.ok(
    fs.existsSync(skillFile),
    `.maestro-skill missing at ${skillFile}\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );
  assert.equal(fs.readFileSync(skillFile, 'utf8').trim(), 'follow-up');

  // (b) .work-state.json must NOT exist (stub-skip gate engaged).
  const workState = path.join(base, 'tasks', ticket, '.work-state.json');
  assert.equal(
    fs.existsSync(workState),
    false,
    `.work-state.json must NOT be written for skill=follow-up (found at ${workState})`
  );

  // (b') Helper must NOT have been invoked (gate must short-circuit before
  // calling bootstrap-custom-script.js).
  const helperCalls = fs.existsSync(helperLog)
    ? fs.readFileSync(helperLog, 'utf8').trim()
    : '';
  assert.equal(
    helperCalls,
    '',
    `bootstrap-custom-script.js helper must not be invoked for skill=follow-up; got: ${helperCalls}`
  );

  // (c) Launcher argv carries `/follow-up <ticket>`, never `/work`.
  const argv = newSessionCalls.join('\n');
  assert.match(
    argv,
    /\/follow-up GH-9001/,
    `tmux new-session argv should contain "/follow-up GH-9001"; got:\n${argv}`
  );
  assert.doesNotMatch(
    argv,
    /\/work GH-9001/,
    `tmux new-session argv must NOT contain "/work GH-9001"; got:\n${argv}`
  );
});

test('Bootstrap default (no --skill, no env) preserves /work behavior bit-for-bit', () => {
  const { wrapper, base, fakeHome, helperLog } = makeSandbox();
  const ticket = 'GH-9001';

  const { stdout, stderr, status, newSessionCalls } = runScript(wrapper, {
    ...RUN_OPTS,
    args: [ticket],
    env: baseEnv(base, fakeHome),
  });

  assert.equal(
    status,
    0,
    `bootstrap should exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`
  );

  // (c.1) Helper invoked (no stub-skip on default skill).
  const helperCalls = fs.existsSync(helperLog)
    ? fs.readFileSync(helperLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  assert.equal(
    helperCalls.length,
    1,
    `bootstrap-custom-script.js must run exactly once for default /work; got ${helperCalls.length} call(s)`
  );

  // (c.2) `.work-state.json` IS written by the (fake) helper — the gate
  // allowed it through because default skill == work.
  const workState = path.join(base, 'tasks', ticket, '.work-state.json');
  assert.ok(
    fs.existsSync(workState),
    `.work-state.json should be written under default /work skill at ${workState}`
  );

  // (c.3) Launcher argv carries `/work <ticket>`, never `/follow-up`.
  const argv = newSessionCalls.join('\n');
  assert.match(
    argv,
    /\/work GH-9001/,
    `tmux new-session argv should contain "/work GH-9001"; got:\n${argv}`
  );
  assert.doesNotMatch(
    argv,
    /\/follow-up GH-9001/,
    `tmux new-session argv must NOT contain "/follow-up" for default skill; got:\n${argv}`
  );
});

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

  assert.equal(status, 0, `bootstrap should exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`);

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
  const helperCalls = fs.existsSync(helperLog) ? fs.readFileSync(helperLog, 'utf8').trim() : '';
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

test('Bare re-bootstrap (no --skill, no env) preserves existing .maestro-skill (PR #561)', () => {
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticket = 'GH-9001';

  // First bootstrap with --skill=follow-up to seed the file.
  const r1 = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--skill=follow-up', ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(
    r1.status,
    0,
    `seed run should exit 0\nstdout:\n${r1.stdout}\nstderr:\n${r1.stderr}`
  );
  const skillFile = path.join(base, 'tasks', ticket, '.maestro-skill');
  assert.equal(fs.readFileSync(skillFile, 'utf8').trim(), 'follow-up');

  // Second bootstrap with NO --skill and NO env — must preserve follow-up.
  const r2 = runScript(wrapper, {
    ...RUN_OPTS,
    args: [ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(r2.status, 0, `re-run should exit 0\nstdout:\n${r2.stdout}\nstderr:\n${r2.stderr}`);
  assert.equal(
    fs.readFileSync(skillFile, 'utf8').trim(),
    'follow-up',
    'bare re-bootstrap must NOT revert .maestro-skill to "work"'
  );
  assert.match(
    r2.stdout,
    /preserved/,
    `re-run stdout should announce that .maestro-skill was preserved; got:\n${r2.stdout}`
  );
});

test('Re-bootstrap with shell-default SKILL_NAME=work does NOT overwrite preserved follow-up (PR #561 review)', () => {
  // Many setups export SKILL_NAME=work as a shell default. If the bootstrap
  // treats that as an "explicit" skill source, every bare re-run would silently
  // revert a prior --skill=follow-up back to work.
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticket = 'GH-9001';

  const r1 = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--skill=follow-up', ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(r1.status, 0, `seed: ${r1.stdout}\n${r1.stderr}`);
  const skillFile = path.join(base, 'tasks', ticket, '.maestro-skill');
  assert.equal(fs.readFileSync(skillFile, 'utf8').trim(), 'follow-up');

  // Re-run with SKILL_NAME=work in env (shell default). MUST preserve follow-up.
  const r2 = runScript(wrapper, {
    ...RUN_OPTS,
    args: [ticket],
    env: baseEnv(base, fakeHome, { SKILL_NAME: 'work' }),
  });
  assert.equal(r2.status, 0, `re-run: ${r2.stdout}\n${r2.stderr}`);
  assert.equal(
    fs.readFileSync(skillFile, 'utf8').trim(),
    'follow-up',
    'SKILL_NAME=work env (shell default) must NOT count as explicit and must NOT clobber preserved follow-up'
  );
});

test('Preserved follow-up skill drives the tmux launcher on re-bootstrap (PR #561 review)', () => {
  // Re-bootstrap that recreates a missing tmux session must launch the
  // PRESERVED skill, not the default "work" — otherwise the conductor reads
  // follow-up while the relaunched pane runs /work (split state).
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticket = 'GH-9001';

  const r1 = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--skill=follow-up', ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(r1.status, 0, `seed: ${r1.stdout}\n${r1.stderr}`);

  // Bare re-run — preserved follow-up must drive launcher argv.
  const r2 = runScript(wrapper, {
    ...RUN_OPTS,
    args: [ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(r2.status, 0, `re-run: ${r2.stdout}\n${r2.stderr}`);
  const argv = r2.newSessionCalls.join('\n');
  assert.match(
    argv,
    /\/follow-up GH-9001/,
    `re-bootstrap with preserved follow-up must launch /follow-up; got:\n${argv}`
  );
  assert.doesNotMatch(
    argv,
    /\/work GH-9001/,
    `re-bootstrap with preserved follow-up must NOT launch /work; got:\n${argv}`
  );
});

test('Unknown --skill value falls open to /work with a stderr warning (PR #561 review)', () => {
  // resolve_skill must validate against the maestro-conduct skill-registry
  // whitelist. A typo like "followup" should NOT launch /followup or persist
  // the bad value (the conductor would silently fall open to /work, producing
  // split state).
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticket = 'GH-9001';

  const r = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--skill=followup', ticket],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(r.status, 0, `bootstrap: ${r.stdout}\n${r.stderr}`);

  // .maestro-skill must be "work" (fell open), not "followup".
  const skillFile = path.join(base, 'tasks', ticket, '.maestro-skill');
  assert.equal(fs.readFileSync(skillFile, 'utf8').trim(), 'work');

  // stderr must announce the fall-open.
  assert.match(
    r.stderr,
    /unknown skill 'followup'/,
    `stderr must warn about unknown skill; got:\n${r.stderr}`
  );

  // Tmux launcher must use /work, not /followup.
  const argv = r.newSessionCalls.join('\n');
  assert.match(argv, /\/work GH-9001/);
  assert.doesNotMatch(argv, /\/followup GH-9001/);
});

test('Batch bootstrap: preserved skill for ticket 1 does NOT leak into ticket 2 (PR #561 review)', () => {
  // Cursor finding: assigning RESOLVED_SKILL=$EXISTING_SKILL inside the loop
  // leaks the value into the next iteration. A bare batch with [ticket-A
  // (preserved follow-up), ticket-B (fresh)] would launch ticket-B as
  // /follow-up instead of /work.
  const { wrapper, base, fakeHome } = makeSandbox();
  const ticketA = 'GH-9101';
  const ticketB = 'GH-9102';

  // Seed ticket A with follow-up.
  const seed = runScript(wrapper, {
    ...RUN_OPTS,
    args: ['--skill=follow-up', ticketA],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(seed.status, 0, `seed: ${seed.stdout}\n${seed.stderr}`);

  // Batch bootstrap A then B with no --skill / no env. A is preserved as
  // follow-up; B is fresh and must default to work — NOT inherit A's value.
  const batch = runScript(wrapper, {
    ...RUN_OPTS,
    args: [ticketA, ticketB],
    env: baseEnv(base, fakeHome),
  });
  assert.equal(batch.status, 0, `batch: ${batch.stdout}\n${batch.stderr}`);

  const skillA = fs
    .readFileSync(path.join(base, 'tasks', ticketA, '.maestro-skill'), 'utf8')
    .trim();
  const skillB = fs
    .readFileSync(path.join(base, 'tasks', ticketB, '.maestro-skill'), 'utf8')
    .trim();
  assert.equal(skillA, 'follow-up', 'ticket A must keep its preserved follow-up');
  assert.equal(skillB, 'work', "ticket B must default to work — NOT inherit A's follow-up");

  const argv = batch.newSessionCalls.join('\n');
  assert.match(argv, /\/follow-up GH-9101/, 'ticket A launcher must use /follow-up');
  assert.match(argv, /\/work GH-9102/, 'ticket B launcher must use /work (not leaked /follow-up)');
  assert.doesNotMatch(
    argv,
    /\/follow-up GH-9102/,
    `ticket B must NOT launch /follow-up (leaked from A); got:\n${argv}`
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

  assert.equal(status, 0, `bootstrap should exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`);

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

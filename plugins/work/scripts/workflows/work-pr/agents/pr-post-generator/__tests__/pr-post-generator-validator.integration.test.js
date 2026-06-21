'use strict';

/**
 * Integration tests for pr-post-generator-validator.js hook.
 *
 * Spawns the hook with child_process.spawn (matching the
 * pr-generator/__tests__ pattern). The hook depends on three external
 * commands — `gh`, `git`, and `node <REPO_DIR>/scripts/get-affected.js` —
 * which we stub by prepending a temp bin directory to PATH and by pointing
 * WORKTREES_BASE/REPO_NAME/APPS_DIR at temp scaffolding.
 *
 * These tests exercise the fabrication-check wiring (Task 2):
 *   case A — fabricated "10/10 stability run" + no artifact → exit 2
 *   case B — only-pending Test Results body → exit 0
 *   case C — body claim sourced by tests.check.md → exit 0
 *   case D — zero affected frontend apps + fabrication phrase → still exit 2
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.join(__dirname, '..', 'pr-post-generator-validator.js');

const TICKET_ID = 'GH-401';
const TICKET_BRANCH = 'GH-401-fabrication-guard';

let SANDBOX;
let TASKS_BASE;
let WORKTREES_BASE;
let REPO_DIR;
let APPS_DIR;
let BIN_DIR;

const AGENT_OUTPUT_STUB =
  'PR updated via gh pr edit; wiki link present at https://github.com/example/repo/wiki/GH-401. ' +
  'Screenshots uploaded to wiki. This filler keeps the payload above the 50-char minimum.';

function writeStubBin(name, body) {
  const filePath = path.join(BIN_DIR, name);
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function setStubs({ prBody, affectedJson }) {
  // gh — only `gh pr view --json body -q .body` is invoked.
  // Quote body so newlines survive heredoc indirection.
  writeStubBin('gh', `#!/usr/bin/env bash\ncat <<'__PR_BODY_EOF__'\n${prBody}\n__PR_BODY_EOF__\n`);
  // git — only `git branch --show-current` is invoked by the new fabrication wiring.
  writeStubBin('git', `#!/usr/bin/env bash\necho '${TICKET_BRANCH}'\n`);
  // get-affected.js — invoked via `node <REPO_DIR>/scripts/get-affected.js main json`.
  // We stamp a stub script the validator can exec.
  const getAffectedDir = path.join(REPO_DIR, 'scripts');
  fs.mkdirSync(getAffectedDir, { recursive: true });
  fs.writeFileSync(
    path.join(getAffectedDir, 'get-affected.js'),
    `process.stdout.write(${JSON.stringify(JSON.stringify(affectedJson))});\n`,
    'utf8'
  );
}

function runHook(payload, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const baseEnv = {
      ...process.env,
      PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH || ''}`,
      WORKTREES_BASE,
      REPO_NAME: 'my-project',
      APPS_DIR,
      TASKS_BASE,
      TICKET_PROVIDER: 'github',
    };
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete baseEnv[k];
      else baseEnv[k] = v;
    }
    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: baseEnv,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

function loadActions() {
  const actionsPath = path.join(TASKS_BASE, TICKET_ID, '.work-actions.json');
  try {
    return JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
  } catch {
    return [];
  }
}

function resetTaskDir() {
  const taskDir = path.join(TASKS_BASE, TICKET_ID);
  if (fs.existsSync(taskDir)) {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
  fs.mkdirSync(taskDir, { recursive: true });
}

before(() => {
  SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-post-val-int-'));
  TASKS_BASE = path.join(SANDBOX, 'tasks');
  WORKTREES_BASE = path.join(SANDBOX, 'worktrees');
  REPO_DIR = path.join(WORKTREES_BASE, 'my-project');
  APPS_DIR = path.join(REPO_DIR, 'apps');
  BIN_DIR = path.join(SANDBOX, 'bin');

  fs.mkdirSync(TASKS_BASE, { recursive: true });
  fs.mkdirSync(APPS_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
});

after(() => {
  if (SANDBOX && fs.existsSync(SANDBOX)) {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
});

describe('pr-post-generator-validator: fabrication check', () => {
  it('PR body contains fabricated stability claim with no artifact', async () => {
    resetTaskDir();
    // One frontend app so the legacy path can run, but the fabrication check
    // should fire BEFORE that and gate the whole hook.
    fs.mkdirSync(path.join(APPS_DIR, 'web'), { recursive: true });
    fs.writeFileSync(path.join(APPS_DIR, 'web', 'react-router.config.ts'), 'export default {};\n');

    const prBody = [
      '## Summary',
      'Adds GH-401 fabrication guard.',
      '',
      'Verified with 10/10 stability run on CI.',
      '',
      '[wiki](https://github.com/example/repo/wiki/GH-401)',
    ].join('\n');

    setStubs({ prBody, affectedJson: ['web'] });

    const { code, stderr } = await runHook({
      agent_name: 'pr-post-generator',
      agent_output: AGENT_OUTPUT_STUB,
    });

    assert.equal(code, 2, `expected exit 2, got ${code}; stderr=\n${stderr}`);
    assert.match(
      stderr,
      /10\/10/,
      `expected stderr to surface the offending phrase; got:\n${stderr}`
    );
    assert.match(stderr, /[╔╗╚╝═║]/, `expected box-drawn ASCII failure block; got:\n${stderr}`);

    const actions = loadActions();
    const fab = actions.filter((a) => a && a.what === 'fabrication-block');
    assert.ok(
      fab.length >= 1,
      `expected at least one fabrication-block row in .work-actions.json; got ${JSON.stringify(actions)}`
    );
  });

  it('PR body contains only pending placeholders', async () => {
    resetTaskDir();
    // Frontend app present + wiki link in PR body so the existing visual-doc
    // checks are satisfied and the hook can reach exit 0.
    fs.mkdirSync(path.join(APPS_DIR, 'web'), { recursive: true });
    fs.writeFileSync(path.join(APPS_DIR, 'web', 'react-router.config.ts'), 'export default {};\n');

    const prBody = [
      '## Summary',
      'Adds GH-401 fabrication guard.',
      '',
      '[wiki](https://github.com/example/repo/wiki/GH-401)',
      '',
      '## Test Results',
      '',
      '| Test | Status | Notes |',
      '| --- | --- | --- |',
      '| modal opens on click | pending | awaiting tests.check.md |',
      '| settings save | not run | follow-up |',
      '',
    ].join('\n');

    setStubs({ prBody, affectedJson: ['web'] });

    const { code, stderr } = await runHook({
      agent_name: 'pr-post-generator',
      agent_output: AGENT_OUTPUT_STUB,
    });

    assert.equal(code, 0, `expected exit 0, got ${code}; stderr=\n${stderr}`);
  });

  it('PR body claims are supported by tests.check.md', async () => {
    resetTaskDir();
    fs.mkdirSync(path.join(APPS_DIR, 'web'), { recursive: true });
    fs.writeFileSync(path.join(APPS_DIR, 'web', 'react-router.config.ts'), 'export default {};\n');

    fs.writeFileSync(
      path.join(TASKS_BASE, TICKET_ID, 'tests.check.md'),
      '# checks\n- modal opens on click: verified locally\n',
      'utf8'
    );

    const prBody = [
      '## Summary',
      'Adds GH-401 fabrication guard.',
      '',
      '[wiki](https://github.com/example/repo/wiki/GH-401)',
      '',
      '## Test Results',
      '',
      '| Test | Status | Notes |',
      '| --- | --- | --- |',
      '| modal opens on click | PASS | covered by E2E |',
      '',
    ].join('\n');

    setStubs({ prBody, affectedJson: ['web'] });

    const { code, stderr } = await runHook({
      agent_name: 'pr-post-generator',
      agent_output: AGENT_OUTPUT_STUB,
    });

    assert.equal(code, 0, `expected exit 0, got ${code}; stderr=\n${stderr}`);
  });

  it('Fails closed when gh pr view fails (cannot fetch PR body)', async () => {
    resetTaskDir();
    // Stub `gh` so it exits non-zero — getPRBody() returns null and the
    // validator must block (exit 2) rather than silently allow.
    writeStubBin('gh', '#!/usr/bin/env bash\nexit 1\n');
    writeStubBin('git', `#!/usr/bin/env bash\necho '${TICKET_BRANCH}'\n`);
    const getAffectedDir = path.join(REPO_DIR, 'scripts');
    fs.mkdirSync(getAffectedDir, { recursive: true });
    fs.writeFileSync(
      path.join(getAffectedDir, 'get-affected.js'),
      `process.stdout.write(${JSON.stringify(JSON.stringify([]))});\n`,
      'utf8'
    );

    const { code, stderr } = await runHook({
      agent_name: 'pr-post-generator',
      agent_output: AGENT_OUTPUT_STUB,
    });

    assert.equal(code, 2, `expected exit 2 when gh pr view fails; got ${code}; stderr=\n${stderr}`);
    assert.match(
      stderr,
      /COULD NOT FETCH PR BODY/,
      `expected block reason in stderr; got:\n${stderr}`
    );
  });

  it('Runs fabrication check even when TASKS_BASE is unset', async () => {
    resetTaskDir();
    const prBody = [
      '## Summary',
      'Adds GH-401 fabrication guard.',
      '',
      'Verified with 10/10 stability run on CI.',
    ].join('\n');

    setStubs({ prBody, affectedJson: [] });

    const { code, stderr } = await runHook(
      { agent_name: 'pr-post-generator', agent_output: AGENT_OUTPUT_STUB },
      { TASKS_BASE: undefined }
    );

    assert.equal(
      code,
      2,
      `expected exit 2 even without TASKS_BASE; got ${code}; stderr=\n${stderr}`
    );
    assert.match(stderr, /10\/10/, `expected stderr to surface the offending phrase`);
  });

  it('Backend-only change still runs the fabrication check', async () => {
    resetTaskDir();
    // No frontend apps registered in APPS_DIR for this case — but even if
    // there were, get-affected returns empty so affectedFrontendApps === [].
    const prBody = [
      '## Summary',
      'Adds GH-401 backend-only guard.',
      '',
      'Verified with 10/10 stability run on CI.',
    ].join('\n');

    setStubs({ prBody, affectedJson: [] });

    const { code, stderr } = await runHook({
      agent_name: 'pr-post-generator',
      agent_output: AGENT_OUTPUT_STUB,
    });

    assert.equal(
      code,
      2,
      `expected exit 2 (fabrication check must run before frontend early-exit); got ${code}; stderr=\n${stderr}`
    );
    assert.match(stderr, /10\/10/, `expected stderr to surface the offending phrase`);
  });
});

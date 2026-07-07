// WP-09 — runtime-profile.js: per-ticket runtime resolution, the
// claude/codex × fresh/resume launch-command matrix (claude strings are
// characterization-locked to the pre-WP-09 restart-launch bytes), the
// dialect map, and the runtime-aware resume probe.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const PROFILE_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'runtime-profile.js');
const MANIFEST_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'manifest.js');
const RESTART_LAUNCH_LIB = path.resolve(
  __dirname,
  '..',
  'lib',
  'maestro-conduct',
  'restart-launch.js'
);

// Env keys the profile chain reads — reset before every fresh require so one
// test's pins can't leak into the next.
const ENV_KEYS = [
  'CLAUDE_BIN',
  'CODEX_BIN',
  'MAESTRO_RUNTIME',
  'STATE_DIR',
  'TASKS_BASE',
  'WORKTREES_BASE',
  'MAESTRO_SESSION_DIR',
  'MAESTRO_NS',
  'MAESTRO_INBOX_DIR',
  'MAESTRO_RESTART_MODE',
];

function freshRequire(lib, env = {}) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/maestro-conduct/') || key.includes('/lib/runtime/')) {
      delete require.cache[key];
    }
  }
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  return require(lib);
}

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-profile-'));
}

test('launchCommand matrix: claude bytes unchanged; codex carries --json + both bypass flags', () => {
  const tmp = sandbox();
  const stateDir = path.join(tmp, 'state');
  const profile = freshRequire(PROFILE_LIB, { STATE_DIR: stateDir });

  // Claude legs — byte-identical to the pre-WP-09 buildLaunchCommand output.
  assert.equal(
    profile.launchCommand({ runtime: 'claude', mode: 'fresh', skill: 'work', ticket: 'GH-42' }),
    "claude --dangerously-skip-permissions '/work GH-42'"
  );
  assert.equal(
    profile.launchCommand({ runtime: 'claude', mode: 'continue', skill: 'work', ticket: 'GH-42' }),
    'claude --dangerously-skip-permissions --continue'
  );

  // Codex legs — design §H strings.
  const log = path.join(stateDir, 'GH-42.exec.jsonl');
  const codexFresh = profile.launchCommand({
    runtime: 'codex',
    mode: 'fresh',
    skill: 'work',
    ticket: 'GH-42',
  });
  assert.equal(
    codexFresh,
    'AGENT_RUNTIME=codex codex exec --json ' +
      '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust ' +
      `"Use the work skill for GH-42" </dev/null | tee -a '${log}'`
  );
  const codexResume = profile.launchCommand({
    runtime: 'codex',
    mode: 'continue',
    skill: 'work',
    ticket: 'GH-42',
  });
  assert.equal(
    codexResume,
    'AGENT_RUNTIME=codex codex exec resume --last --json ' +
      '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust ' +
      `</dev/null | tee -a '${log}'`
  );

  // C9: hook-trust bypass is MANDATORY on every codex launch form — without
  // it the entire /work enforcement layer is silently off.
  for (const cmd of [codexFresh, codexResume]) {
    assert.match(cmd, /--dangerously-bypass-hook-trust/);
    assert.match(cmd, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(cmd, /<\/dev\/null/);
  }
  // …and the claude commands must never grow codex flags.
  for (const mode of ['fresh', 'continue']) {
    const cmd = profile.launchCommand({ runtime: 'claude', mode, skill: 'work', ticket: 'GH-42' });
    assert.doesNotMatch(cmd, /bypass-hook-trust|AGENT_RUNTIME=/);
  }
});

test('launchCommand: inboxEnv prefix rides along; bins are env-overridable', () => {
  const tmp = sandbox();
  const profile = freshRequire(PROFILE_LIB, {
    STATE_DIR: path.join(tmp, 'state'),
    CLAUDE_BIN: 'my-claude',
    CODEX_BIN: 'my-codex',
  });
  const inboxEnv = "CLAUDE_AGENT_INBOX_DIR='/tmp/inbox-x' ";
  assert.equal(
    profile.launchCommand({
      runtime: 'claude',
      mode: 'fresh',
      skill: 'work',
      ticket: 'GH-1',
      inboxEnv,
    }),
    "CLAUDE_AGENT_INBOX_DIR='/tmp/inbox-x' my-claude --dangerously-skip-permissions '/work GH-1'"
  );
  const codex = profile.launchCommand({
    runtime: 'codex',
    mode: 'fresh',
    skill: 'follow-up',
    ticket: 'GH-1',
    inboxEnv,
  });
  assert.match(
    codex,
    /^CLAUDE_AGENT_INBOX_DIR='\/tmp\/inbox-x' AGENT_RUNTIME=codex my-codex exec /
  );
  assert.match(codex, /"Use the follow-up skill for GH-1"/);
});

test('buildLaunchCommand (restart-launch): claude output byte-identical through the profile delegation', () => {
  const tmp = sandbox();
  const restartLaunch = freshRequire(RESTART_LAUNCH_LIB, {
    STATE_DIR: path.join(tmp, 'state'),
    CLAUDE_BIN: 'fake-claude',
    MAESTRO_INBOX_DIR: '/tmp/maestro-test-inbox',
  });
  // HEAD literals: inboxEnvPrefix() + CLAUDE_BIN + the two claude forms.
  assert.equal(
    restartLaunch.buildLaunchCommand('fresh', 'work', 'GH-9'),
    "CLAUDE_AGENT_INBOX_DIR='/tmp/maestro-test-inbox' fake-claude --dangerously-skip-permissions '/work GH-9'"
  );
  assert.equal(
    restartLaunch.buildLaunchCommand('continue', 'qc-work', 'GH-9'),
    "CLAUDE_AGENT_INBOX_DIR='/tmp/maestro-test-inbox' fake-claude --dangerously-skip-permissions --continue"
  );
  // Codex leg via the same call site.
  const codex = restartLaunch.buildLaunchCommand('fresh', 'work', 'GH-9', 'codex');
  assert.match(codex, /--dangerously-bypass-hook-trust/);
  assert.match(codex, /GH-9\.exec\.jsonl/);
});

test('runtimeForTicket: .maestro-runtime file → manifest → MAESTRO_RUNTIME env → claude', () => {
  const tmp = sandbox();
  const tasksBase = path.join(tmp, 'tasks');
  const manifestDir = path.join(tmp, 'manifests');
  fs.mkdirSync(manifestDir, { recursive: true });
  const profile = freshRequire(PROFILE_LIB, {
    STATE_DIR: path.join(tmp, 'state'),
    TASKS_BASE: tasksBase,
    MAESTRO_SESSION_DIR: manifestDir,
  });

  // Nothing anywhere → the load-bearing claude default.
  assert.equal(profile.runtimeForTicket('GH-1'), 'claude');

  // Env leg.
  process.env.MAESTRO_RUNTIME = 'codex';
  assert.equal(profile.runtimeForTicket('GH-1'), 'codex');

  // Manifest leg outranks env (task-level runtime).
  fs.writeFileSync(
    path.join(manifestDir, 'topic.json'),
    JSON.stringify({
      topic: 'topic',
      createdAt: new Date().toISOString(),
      tasks: [{ id: 'GH-1', status: 'pending', runtime: 'claude' }],
    })
  );
  assert.equal(profile.runtimeForTicket('GH-1'), 'claude');

  // File leg outranks everything.
  fs.mkdirSync(path.join(tasksBase, 'GH-1'), { recursive: true });
  fs.writeFileSync(path.join(tasksBase, 'GH-1', '.maestro-runtime'), 'codex\n');
  assert.equal(profile.runtimeForTicket('GH-1'), 'codex');

  // Malformed file falls through to the manifest value.
  fs.writeFileSync(path.join(tasksBase, 'GH-1', '.maestro-runtime'), 'gpt6\n');
  assert.equal(profile.runtimeForTicket('GH-1'), 'claude');
});

test('mixed-fleet manifest round-trips runtime through syncFromTmux', () => {
  const tmp = sandbox();
  const manifestDir = path.join(tmp, 'manifests');
  fs.mkdirSync(manifestDir, { recursive: true });
  const file = path.join(manifestDir, 'fleet.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      topic: 'fleet',
      createdAt: new Date().toISOString(),
      runtime: 'claude',
      tasks: [
        { id: 'GH-7', status: 'pending', runtime: 'codex' },
        { id: 'GH-8', status: 'pending' },
      ],
    })
  );
  const manifest = freshRequire(MANIFEST_LIB, {
    STATE_DIR: path.join(tmp, 'state'),
    MAESTRO_SESSION_DIR: manifestDir,
  });
  assert.equal(manifest.runtimeForTask('GH-7'), 'codex', 'task-level runtime wins');
  assert.equal(manifest.runtimeForTask('GH-8'), 'claude', 'pool-level runtime is the default');
  assert.equal(manifest.runtimeForTask('GH-999'), null, 'untracked ticket → null');

  // Status reconciliation must not strip the runtime fields.
  manifest.syncFromTmux(['GH-7-work']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.runtime, 'claude');
  assert.equal(after.tasks[0].runtime, 'codex');
  assert.equal(after.tasks[0].status, 'in_progress', 'reconciliation still ran');
  assert.equal(manifest.runtimeForTask('GH-7'), 'codex', 'round-trips after rewrite');
});

test('paneDialect: claude-tui / codex-exec-json (stream present) / codex-tui-conservative', () => {
  const tmp = sandbox();
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const profile = freshRequire(PROFILE_LIB, {
    STATE_DIR: stateDir,
    TASKS_BASE: path.join(tmp, 'tasks'),
    MAESTRO_SESSION_DIR: path.join(tmp, 'manifests'),
  });
  assert.equal(profile.paneDialect('GH-5', 'claude'), 'claude-tui');
  assert.equal(profile.paneDialect('GH-5', 'codex'), 'codex-tui-conservative');
  fs.writeFileSync(profile.execLogPath('GH-5'), '{"type":"thread.started"}\n');
  assert.equal(profile.paneDialect('GH-5', 'codex'), 'codex-exec-json');
  // Runtime omitted → resolved via the profile chain (claude here).
  assert.equal(profile.paneDialect('GH-5'), 'claude-tui');
});

test('hasResumable: claude probe reads the flattened-cwd project dir', () => {
  const tmp = sandbox();
  const worktree = path.join(tmp, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const projectsRoot = path.join(tmp, 'projects');
  const profile = freshRequire(PROFILE_LIB, { STATE_DIR: path.join(tmp, 'state') });

  assert.equal(profile.hasResumable('claude', worktree, { root: projectsRoot }), false);

  const encoded = path.resolve(worktree).replace(/[^A-Za-z0-9-]/g, '-');
  fs.mkdirSync(path.join(projectsRoot, encoded), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, encoded, 'session-1.jsonl'), '{"type":"user"}\n');
  assert.equal(profile.hasResumable('claude', worktree, { root: projectsRoot }), true);
});

test('hasResumable: codex probe walks the rollout tree matching session_meta.cwd', () => {
  const tmp = sandbox();
  const worktree = path.join(tmp, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const sessionsRoot = path.join(tmp, 'sessions');
  const now = new Date();
  const dayDir = path.join(
    sessionsRoot,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dayDir, { recursive: true });
  const profile = freshRequire(PROFILE_LIB, { STATE_DIR: path.join(tmp, 'state') });

  // A rollout for a DIFFERENT cwd must not count.
  fs.writeFileSync(
    path.join(dayDir, 'rollout-2026-07-07T10-00-00-018f0000000070008000000000000001.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/somewhere/else' } })}\n`
  );
  assert.equal(profile.hasResumable('codex', worktree, { root: sessionsRoot }), false);

  fs.writeFileSync(
    path.join(dayDir, 'rollout-2026-07-07T11-00-00-018f0000000070008000000000000002.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: path.resolve(worktree) } })}\n`
  );
  assert.equal(profile.hasResumable('codex', worktree, { root: sessionsRoot }), true);
});

test('grooming: codex has no composer — rename skipped, context via inbox', () => {
  const tmp = sandbox();
  const profile = freshRequire(PROFILE_LIB, { STATE_DIR: path.join(tmp, 'state') });
  assert.deepEqual(profile.grooming('claude'), { rename: true, contextChannel: 'composer' });
  assert.deepEqual(profile.grooming('codex'), { rename: false, contextChannel: 'inbox' });
});

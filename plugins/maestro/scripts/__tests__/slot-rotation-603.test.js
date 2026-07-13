// PR #603 port — CI-phase rotation, self-rebootstrap exclusion, phase-advance
// attempt reset, and the global pool cap.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const LIB = (name) => path.resolve(__dirname, '..', 'lib', 'maestro-conduct', name);

function makeFakeBinDir(logPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-603-'));
  for (const name of ['tmux', 'bash']) {
    fs.writeFileSync(
      path.join(dir, name),
      `#!/bin/bash\nprintf '%s\\0' "${name}" "$@" >> "${logPath}"\nprintf '\\n' >> "${logPath}"\nexit 0\n`,
      { mode: 0o755 }
    );
  }
  return dir;
}

function loadFresh(fakeDir, env = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/') || k.includes('maestro-cleanup')) delete require.cache[k];
  }
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-603-sinks-'));
  Object.assign(
    process.env,
    {
      LOG_FILE: path.join(iso, 'conduct.log'),
      ALERT_FILE: path.join(iso, 'alerts.jsonl'),
      STATE_DIR: path.join(iso, 'state'),
      MAESTRO_SESSION_DIR: path.join(iso, 'sessions'),
      MAESTRO_GROOM_DELAY_SEC: '0',
      MAESTRO_SEND_VERIFY_DELAY_SEC: '0',
      CLAUDE_BIN: 'fake-claude',
    },
    env
  );
  if (!('AUTO_FREE_CI_SLOT' in env)) delete process.env.AUTO_FREE_CI_SLOT;
  if (!('AUTO_BOOTSTRAP_NEXT' in env)) delete process.env.AUTO_BOOTSTRAP_NEXT;
  process.env.PATH = `${fakeDir}:${process.env.PATH}`;
  return {
    actions: require(LIB('actions.js')),
    manifest: require(LIB('manifest.js')),
    state: require(LIB('state.js')),
    nextTask: require(LIB('next-task.js')),
    ciGate: require(LIB('ci-gate-rotation.js')),
    phaseAdvance: require(LIB('phase-advance.js')),
  };
}

function writeManifest(tasks, extra = {}) {
  fs.mkdirSync(process.env.MAESTRO_SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.MAESTRO_SESSION_DIR, `${extra.topic || 'topic'}.json`),
    JSON.stringify({
      topic: extra.topic || 'topic',
      slots: extra.slots || 2,
      createdAt: extra.createdAt || new Date().toISOString(),
      ...extra,
      tasks,
    })
  );
}

function invocations(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\0').filter(Boolean));
}

test('freeCiPhaseSlot: complete → done, ci → awaiting-merge; idempotent; togglable', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-rotate-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const { actions, manifest, state } = loadFresh(makeFakeBinDir(logPath));
  writeManifest([
    { id: 'GH-20', priority: 1, deps: [], status: 'in_progress' },
    { id: 'GH-21', priority: 2, deps: [], status: 'in_progress' },
  ]);

  assert.equal(
    actions.freeCiPhaseSlot({ session: 'GH-20-work', ticket: 'GH-20', phase: 'complete' }),
    true
  );
  assert.equal(manifest.findTask('GH-20').task.status, 'done', 'complete phase → done');
  assert.ok(state.read('GH-20', 'ci-gate-freed').killed, 'restart guard armed');
  // Idempotent: second call no-ops.
  assert.equal(
    actions.freeCiPhaseSlot({ session: 'GH-20-work', ticket: 'GH-20', phase: 'complete' }),
    false
  );

  assert.equal(
    actions.freeCiPhaseSlot({ session: 'GH-21-work', ticket: 'GH-21', phase: 'ci' }),
    true
  );
  assert.equal(
    manifest.findTask('GH-21').task.status,
    'awaiting-merge',
    'ci phase → awaiting-merge (NOT done, NOT pending)'
  );

  // Kill switch is the CI slot toggle, independent of AUTO_FREE_DEAD_END.
  process.env.AUTO_FREE_CI_SLOT = '0';
  state.clear('GH-21', 'ci-rotated');
  assert.equal(
    actions.freeCiPhaseSlot({ session: 'GH-21-work', ticket: 'GH-21', phase: 'ci' }),
    false
  );
  delete process.env.AUTO_FREE_CI_SLOT;
});

test('ci-gate rotation only applies to /work agents (follow-up complete ≠ done)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-skillgate-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const { ciGate } = loadFresh(makeFakeBinDir(logPath));
  let called = 0;
  const actionsStub = { freeCiPhaseSlot: () => ((called += 1), true) };
  const restartEligible = (s) => /-work$/.test(s);

  // follow-up healthy-idle maps to phase 'complete' — must NOT rotate.
  ciGate.maybeRotateOnPhase({
    ctx: { session: 'GH-30-work', ticket: 'GH-30', phase: 'complete', skill: 'follow-up' },
    state: null,
    actions: actionsStub,
    restartEligible,
  });
  assert.equal(called, 0, 'follow-up agents rotate via stop-oracles, not phases');

  ciGate.maybeRotateOnPhase({
    ctx: { session: 'GH-30-work', ticket: 'GH-30', phase: 'complete', skill: 'work' },
    state: null,
    actions: actionsStub,
    restartEligible,
  });
  assert.equal(called, 1, '/work agents rotate at ci/complete');
});

test('killAndBootstrapNext excludes the just-killed ticket from the next pick', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exclude-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const { actions, state, manifest } = loadFresh(makeFakeBinDir(logPath), {
    AUTO_BOOTSTRAP_NEXT: '1',
  });
  // GH-40 tops the queue even after being re-queued pending; GH-41 is next.
  writeManifest([
    { id: 'GH-40', priority: 1, deps: [], status: 'in_progress' },
    { id: 'GH-41', priority: 2, deps: [], status: 'pending' },
  ]);
  // Drive a full dead-end kill for GH-40 (probe → backdate → kill).
  const args = { session: 'GH-40-work', ticket: 'GH-40', kind: 'nudges-exhausted', repeatCount: 3 };
  actions.freeDeadEndSlot(args);
  const m = state.read('GH-40', 'dead-end');
  state.write('GH-40', 'dead-end', { ...m, diagnosedAt: state.now() - 3600 });
  actions.freeDeadEndSlot(args);
  // GH-40 went back to pending (attempt 1/3) at priority 1 — but the
  // bootstrap must pick GH-41, never the just-killed GH-40.
  assert.equal(manifest.findTask('GH-40').task.status, 'pending');
  const bootstraps = invocations(logPath)
    .filter((i) => i[0] === 'bash')
    .map((i) => i[i.length - 1]);
  assert.deepEqual(bootstraps, ['GH-41'], `must bootstrap GH-41 only, got: ${bootstraps}`);
});

test('detectPhaseAdvance resets dead-end attempts and marker on phase change', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phaseadv-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const { manifest, state, phaseAdvance } = loadFresh(makeFakeBinDir(logPath));
  writeManifest([{ id: 'GH-50', priority: 1, deps: [], status: 'in_progress' }]);
  manifest.incrementTaskAttempts('GH-50');
  manifest.incrementTaskAttempts('GH-50');
  state.write('GH-50', 'dead-end', { diagnosed: true, diagnosedAt: state.now() });
  const restartEligible = (s) => /-work$/.test(s);

  // First sighting arms last-phase; no reset yet.
  phaseAdvance.detectPhaseAdvance(
    { session: 'GH-50-work', ticket: 'GH-50', phase: 'implement' },
    restartEligible
  );
  assert.equal(manifest.getTaskAttempts('GH-50'), 2);

  // Phase advance → attempts + dead-end marker reset.
  phaseAdvance.detectPhaseAdvance(
    { session: 'GH-50-work', ticket: 'GH-50', phase: 'commit' },
    restartEligible
  );
  assert.equal(manifest.getTaskAttempts('GH-50'), 0, 'attempts reset on real progress');
  assert.equal(state.read('GH-50', 'dead-end'), null, 'dead-end marker cleared');
});

test('autoRestart marker wipe restores the probe entitlement for the new lifecycle', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-entitle-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const fakeDir = makeFakeBinDir(logPath);
  const { actions, state } = loadFresh(fakeDir);
  const runners = require(LIB('detector-runners.js'));
  writeManifest([
    { id: 'GH-90', priority: 1, deps: [], status: 'in_progress' },
    { id: 'GH-91', priority: 2, deps: [], status: 'pending' },
  ]);
  const restartEligible = (s) => /-work$/.test(s);

  // Probe fired, grace long elapsed — the classic bypass setup: without the
  // marker wipe, the NEXT lifecycle's first dead-end would kill instead of
  // probing.
  state.write('GH-90', 'dead-end', {
    diagnosed: true,
    diagnosedAt: state.now() - 3600,
    trigger: 'nudges-exhausted',
  });
  const worktree = path.join(tmpDir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  // Drive the silence path end-to-end: first detect arms the marker with the
  // real pane hash; backdating lastActiveAt then makes the same static pane
  // count as SILENCE_LIMIT_SEC-expired on the second detect.
  const ctx = {
    session: 'GH-90-work',
    ticket: 'GH-90',
    worktree,
    pane: 'static pane\n',
    skill: 'work',
    phase: 'implement',
  };
  assert.equal(runners.runSilenceDetector(ctx, { restartEligible }), false, 'first sighting arms');
  const sm = state.read('GH-90-work', 'silence');
  state.write('GH-90-work', 'silence', { ...sm, lastActiveAt: state.now() - 3600 });
  const handled = runners.runSilenceDetector(ctx, { restartEligible });
  assert.equal(handled, true, 'restart must fire');
  assert.equal(
    state.read('GH-90', 'dead-end'),
    null,
    'stale diagnosed marker must be wiped so the new lifecycle gets a fresh probe'
  );
  // And the next dead-end is a PROBE (no kill): attempts stays 0.
  actions.freeDeadEndSlot({
    session: 'GH-90-work',
    ticket: 'GH-90',
    kind: 'nudges-exhausted',
    repeatCount: 3,
  });
  const manifestMod = require(LIB('manifest.js'));
  assert.equal(manifestMod.getTaskAttempts('GH-90'), 0, 'fresh lifecycle probes before striking');
  assert.ok(state.read('GH-90', 'dead-end').diagnosed, 'probe marker armed');
});

test('poolFullForTask counts live -work sessions globally (cross-manifest)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'globalcap-'));
  const { manifest } = loadFresh(makeFakeBinDir(path.join(tmpDir, 'l.log')));
  writeManifest([{ id: 'GH-60', priority: 1, deps: [], status: 'pending' }], {
    topic: 'a-batch',
    slots: 1,
  });
  writeManifest([{ id: 'GH-70', priority: 1, deps: [], status: 'in_progress' }], {
    topic: 'b-batch',
    slots: 5,
  });
  // GH-70 (other manifest) holds the only slot a-batch allows → full.
  assert.equal(manifest.poolFullForTask('GH-60', ['GH-70-work']), true);
  // Unknown live session still counts (real machine capacity).
  assert.equal(manifest.poolFullForTask('GH-60', ['GH-999-work']), true);
  // Done tickets' parked sessions do not count.
  writeManifest([{ id: 'GH-70', priority: 1, deps: [], status: 'done' }], {
    topic: 'b-batch',
    slots: 5,
  });
  assert.equal(manifest.poolFullForTask('GH-60', ['GH-70-work']), false);
});

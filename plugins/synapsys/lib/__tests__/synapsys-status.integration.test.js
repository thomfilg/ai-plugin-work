'use strict';

// RED phase — Task 10 (GH-513): synapsys-status CLI integration.
//
// Spawns the real `synapsys-status.js` with a stub HOME containing both a
// `DOMAINS.md` registry and a sticky-state file, then asserts:
//   - Active domains are reported with signal attribution.
//   - Missing registry/state → fail-open "no active domains", exit 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATUS_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-status.js');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-status-'));
  fs.mkdirSync(path.join(home, '.claude', 'synapsys', '.state'), { recursive: true });
  return home;
}

function writeRegistry(home, body) {
  fs.writeFileSync(path.join(home, '.claude', 'synapsys', 'DOMAINS.md'), body);
}

function writeStickyState(home, state) {
  fs.writeFileSync(
    path.join(home, '.claude', 'synapsys', '.state', 'sticky-domains.json'),
    JSON.stringify(state)
  );
}

function runStatus(home, args = []) {
  return spawnSync(process.execPath, [STATUS_SCRIPT, '--no-color', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, SYNAPSYS_HOME: home },
  });
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

test('synapsys:status skill reports the live active domain set', () => {
  const home = makeHome();
  writeRegistry(
    home,
    [
      'root: git',
      '  leaf: commit',
      '    signal_prompt: \\bgit commit\\b',
      '    signal_pretool: ^Bash:git commit',
      'root: testing',
      '  leaf: e2e',
      '    signal_prompt: \\bplaywright\\b',
      '',
    ].join('\n')
  );

  const res = runStatus(home, [
    '--session-id=sess-1',
    '--prompt=please run git commit -m fix',
    '--tool=Bash:git commit -m fix',
  ]);

  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const out = stripAnsi(res.stdout);

  // Active set rendering: root + qualified leaf both present.
  assert.match(out, /\bgit\b/, 'active root domain `git` present');
  assert.match(out, /git:commit\b/, 'active leaf `git:commit` present');

  // Signal attribution: tell user WHICH signal fired for git:commit.
  assert.match(out, /signal_prompt|signal_pretool|prompt|pretool/, 'attribution shown');

  // Non-matching domain should NOT appear in active list.
  assert.doesNotMatch(out, /testing:e2e\b/);
});

test('synapsys-status: sticky-carry is rendered with attribution', () => {
  const home = makeHome();
  writeRegistry(
    home,
    ['root: git', '  leaf: commit', '    signal_prompt: \\bgit commit\\b', ''].join('\n')
  );
  // Sticky entry for a different session — no raw match this turn.
  writeStickyState(home, {
    'sess-sticky': {
      git: { activeStreak: 3, quietStreak: 0, sticky: true, lastSeenTs: Date.now() },
      'git:commit': { activeStreak: 3, quietStreak: 0, sticky: true, lastSeenTs: Date.now() },
    },
  });

  const res = runStatus(home, ['--session-id=sess-sticky', '--prompt=hello world']);
  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const out = stripAnsi(res.stdout);
  assert.match(out, /\bgit\b/);
  assert.match(out, /sticky/i, 'sticky-carry attribution present');
});

test('synapsys-status: missing registry → fail-open no active domains, exit 0', () => {
  const home = makeHome();
  // No DOMAINS.md, no sticky state.
  const res = runStatus(home, ['--session-id=sess-x', '--prompt=anything']);
  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const out = stripAnsi(res.stdout);
  assert.match(out, /no active domains/i);
});

test('synapsys-status --json emits structured active set with attribution', () => {
  const home = makeHome();
  writeRegistry(
    home,
    ['root: git', '  leaf: commit', '    signal_prompt: \\bgit commit\\b', ''].join('\n')
  );

  const res = runStatus(home, ['--json', '--session-id=sess-json', '--prompt=git commit now']);
  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed.active), 'active is array');
  assert.ok(parsed.active.includes('git'));
  assert.ok(parsed.active.includes('git:commit'));
});

test('synapsys-status: read-only — does not advance sticky streaks across repeated calls', () => {
  const home = makeHome();
  writeRegistry(
    home,
    ['root: git', '  leaf: commit', '    signal_prompt: \\bgit commit\\b', ''].join('\n')
  );
  const initialState = {
    'sess-ro': {
      git: { activeStreak: 1, quietStreak: 0, sticky: false, lastSeenTs: Date.now() },
      'git:commit': { activeStreak: 1, quietStreak: 0, sticky: false, lastSeenTs: Date.now() },
    },
  };
  writeStickyState(home, initialState);
  const stickyPath = path.join(home, '.claude', 'synapsys', '.state', 'sticky-domains.json');

  for (let i = 0; i < 2; i += 1) {
    const res = runStatus(home, ['--session-id=sess-ro', '--prompt=git commit -m wip']);
    assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  }

  const after = JSON.parse(fs.readFileSync(stickyPath, 'utf8'));
  assert.deepEqual(after, initialState, 'status CLI must not mutate persisted sticky state');

  // Sharper: a domain at the edge of being dropped must still appear active in
  // status output until the HOOK (source of truth) advances the streak. Status
  // calling classifyWithSticky would have stepped quietStreak to threshold and
  // dropped the entry, making status disagree with the hook.
  writeStickyState(home, {
    'sess-edge': {
      git: { activeStreak: 0, quietStreak: 2, sticky: true, lastSeenTs: Date.now() },
    },
  });
  const res = runStatus(home, ['--json', '--session-id=sess-edge', '--prompt=hello world']);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.active.includes('git'), 'sticky domain still active per persisted state');
});

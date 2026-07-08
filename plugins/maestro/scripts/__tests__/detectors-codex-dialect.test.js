// WP-09 — dialect gating of the pane detectors.
//
// Acceptance: a codex TUI pane can NEVER be auto-killed on glyph evidence.
// The 'codex-tui-conservative' dialect has no readable grammar, so every
// pane detector must return {hit:false, capability:'unsupported'} for ANY
// pane content and ANY marker age — never an idle/hang/stuck verdict that
// could feed actions.autoRestart / freeDeadEndSlot. Claude behavior (dialect
// undefined or 'claude-tui') stays byte-identical.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DETECTORS_DIR = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'detectors');
const STATE_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state.js');

function freshModules(env = {}) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/maestro-conduct/')) delete require.cache[key];
  }
  Object.assign(process.env, env);
  return {
    silence: require(path.join(DETECTORS_DIR, 'silence.js')),
    question: require(path.join(DETECTORS_DIR, 'question.js')),
    spinner: require(path.join(DETECTORS_DIR, 'spinner.js')),
    stuckInput: require(path.join(DETECTORS_DIR, 'stuck-input.js')),
    state: require(STATE_LIB),
  };
}

function stateSandbox() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dialect-')), 'state');
}

// Pane fragments that trip every claude-tui heuristic — the strongest
// possible "glyph evidence" a codex TUI pane could accidentally render.
const PANE_FRAGMENTS = [
  '✻ Synthesizing… (40m 35s · ↓ 78.2k tokens)',
  '* Cooked for 1m 57s · 1 monitor still running',
  '│ ❯ 1. Yes, proceed',
  'Do you want to proceed?',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '❯ run the deploy now',
  '12345 tokens',
  'Permission rule Bash(rm:*) requires confirmation',
  '$ tail -f /var/log/syslog',
  '',
];

// Deterministic PRNG so failures reproduce.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPane(rand) {
  const lines = [];
  const count = 3 + Math.floor(rand() * 12);
  for (let i = 0; i < count; i++) {
    lines.push(PANE_FRAGMENTS[Math.floor(rand() * PANE_FRAGMENTS.length)]);
  }
  // Never empty: an empty pane is the runtime-neutral session-gone signal,
  // covered separately below.
  lines.push('status');
  return lines.join('\n');
}

test('property: codex-tui-conservative never yields a hit from pane content, even with aged markers', () => {
  const { silence, question, spinner, stuckInput, state } = freshModules({
    STATE_DIR: stateSandbox(),
  });
  const rand = mulberry32(0xc0dec);
  for (let i = 0; i < 200; i++) {
    const pane = randomPane(rand);
    const session = `GH-${i}-work`;
    // Pre-age every marker a codex pane could inherit so "silent long enough"
    // and "same composer text twice" can never manufacture a verdict.
    state.write(session, 'silence', { hash: 'x', tokens: 1, lastActiveAt: state.now() - 99999 });
    state.write(session, 'stuck-input', {
      text: 'run the deploy now',
      firstSeenAt: state.now() - 99999,
    });
    const ctx = {
      session,
      ticket: `GH-${i}`,
      pane,
      skill: 'work',
      dialect: 'codex-tui-conservative',
    };
    for (const detector of [silence, question, spinner, stuckInput]) {
      const verdict = detector.detect(ctx);
      assert.equal(
        verdict.hit,
        false,
        `${detector.name} must never hit on codex-tui-conservative (iteration ${i}, pane:\n${pane})`
      );
      assert.equal(verdict.capability, 'unsupported');
    }
  }
});

test('codex-exec-json pane detectors are unsupported too (evidence lives in the stream)', () => {
  const { question, spinner, stuckInput } = freshModules({ STATE_DIR: stateSandbox() });
  const ctx = {
    session: 'GH-1-work',
    ticket: 'GH-1',
    pane: PANE_FRAGMENTS.join('\n'),
    dialect: 'codex-exec-json',
  };
  for (const detector of [question, spinner, stuckInput]) {
    assert.deepEqual(detector.detect(ctx), { hit: false, capability: 'unsupported' });
  }
});

test('silence on codex-exec-json delegates to the exec-json stream detector', () => {
  const stateDir = stateSandbox();
  const tmp = path.dirname(stateDir);
  const { silence, state } = freshModules({ STATE_DIR: stateDir });
  const execLog = path.join(tmp, 'GH-3.exec.jsonl');
  fs.writeFileSync(execLog, '{"type":"thread.started"}\n');
  const ctx = {
    session: 'GH-3-work',
    ticket: 'GH-3',
    pane: 'raw codex exec output — no claude glyphs',
    skill: 'work',
    dialect: 'codex-exec-json',
    execLog,
  };
  assert.equal(silence.detect(ctx).hit, false, 'first sighting is alive');
  // Stalled stream past the (default 300s) limit → the silence-shaped hit the
  // restart path consumes.
  state.write('GH-3-work', 'exec-json', {
    size: fs.statSync(execLog).size,
    lastActiveAt: state.now() - 9999,
  });
  const hit = silence.detect(ctx);
  assert.equal(hit.hit, true);
  assert.equal(hit.kind, 'silence');
});

test('session-gone stays runtime-neutral: a vanished pane fires on every dialect', () => {
  const { silence } = freshModules({ STATE_DIR: stateSandbox() });
  for (const dialect of [undefined, 'claude-tui', 'codex-exec-json', 'codex-tui-conservative']) {
    const verdict = silence.detect({ session: 'GH-4-work', ticket: 'GH-4', pane: '', dialect });
    assert.equal(verdict.hit, true, `dialect=${dialect}`);
    assert.equal(verdict.kind, 'session-gone');
  }
});

test("claude characterization: undefined dialect keeps today's verdicts", () => {
  const { silence, question, spinner, state } = freshModules({ STATE_DIR: stateSandbox() });
  // Live spinner → silence sees activity, spinner measures the timer.
  const spinning = '✻ Synthesizing… (40m 35s · ↓ 78.2k tokens)';
  assert.equal(silence.detect({ session: 'GH-5-work', ticket: 'GH-5', pane: spinning }).hit, false);
  const sHit = spinner.detect({ pane: spinning });
  assert.equal(sHit.hit, true);
  assert.equal(sHit.kind, 'spinner-hang');
  // Question menu → question detector hits.
  const menu = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  assert.equal(question.detect({ pane: menu }).hit, true);
  // Static pane + aged marker → silence hit (the pre-WP-09 restart trigger).
  state.write('GH-6-work', 'silence', {
    hash: 'stale',
    tokens: null,
    lastActiveAt: state.now() - 9999,
  });
  const still = 'nothing but a status bar';
  silence.detect({ session: 'GH-6-work', ticket: 'GH-6', pane: still }); // hash change → refresh
  state.write('GH-6-work', 'silence', {
    ...(state.read('GH-6-work', 'silence') || {}),
    lastActiveAt: state.now() - 9999,
  });
  const verdict = silence.detect({ session: 'GH-6-work', ticket: 'GH-6', pane: still });
  assert.equal(verdict.hit, true);
  assert.equal(verdict.kind, 'silence');
});

'use strict';

// Integration tests for the synapsys dispatcher 16k injection budget pass with
// demote-instead-of-drop semantics (GH-588 Task 2). Mirrors the spawn pattern
// from dispatcher-fire-mode.integration.test.js: the dispatcher runs end-to-end
// in a child process against an isolated tmp HOME/cwd fixture so the per-session
// inject ledger is read/written on disk and stderr can be observed.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');

// Sentinel substring stamped into every fixture body. The actual body bulk is
// padded `.` characters so we can dial the exact rendered size while keeping a
// stable substring to grep for in stdout. Body sizing is approximate — header
// chars added by `formatMemory` are small relative to the budget.
function makeBody(sentinel, totalChars) {
  const padLen = Math.max(0, totalChars - sentinel.length);
  return `${sentinel}${'.'.repeat(padLen)}`;
}

function writeMemory(dir, file, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, file), `---\n${fm}\n---\n${body}`);
}

function runDispatcher({ event, payload, home, env = {} }) {
  // Strip CLAUDE_CODE_SESSION_ID from the inherited env so the dispatcher's
  // `resolveFromEnv` leg cannot hijack the payload's `session_id`. Otherwise
  // every test under an interactive Claude Code session would land in the
  // host session's ledger file instead of our fixture's. Mirrors the
  // dispatcher-fire-mode pattern (it spawns inside an isolated tmp HOME).
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDE_CODE_SESSION_ID;
  const res = spawnSync(process.execPath, [DISPATCHER, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...baseEnv,
      HOME: home,
      SYNAPSYS_NO_SETUP_HINT: '1',
      ...env,
    },
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

function setupFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-budget-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'local', projectName: 'budget-fixture', schemaVersion: 1 })
  );
  return { base, home, cwd, storeDir };
}

const SESSION_ID = 'budget-session-abc';

function promptPayload(prompt, cwd) {
  return { cwd, session_id: SESSION_ID, prompt };
}

function readLedger(home) {
  const ledgerPath = path.join(home, '.claude', 'synapsys', '.session', `${SESSION_ID}.json`);
  if (!fs.existsSync(ledgerPath)) return { memories: {} };
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}

function injectedCount(ledger, name) {
  const e = ledger.memories && ledger.memories[name];
  return Number(e && e.injectedCount) || 0;
}

// Write `n` memories named `a`, `b`, … that all match the prompt token
// `BUDGETTRIGGER`. Each body is sized to `sizes[i]` and stamped with a unique
// sentinel `SENTINEL-<name>`.
function seedMatchedMemories(storeDir, names, sizes, opts = {}) {
  const fireMode = opts.fireMode || 'always';
  names.forEach((name, i) => {
    writeMemory(
      storeDir,
      `${name}.md`,
      {
        name,
        description: `mem-${name}`,
        events: 'UserPromptSubmit',
        trigger_prompt: 'BUDGETTRIGGER',
        inject: 'full',
        fire_mode: fireMode,
      },
      makeBody(`SENTINEL-${name}`, sizes[i])
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('dispatcher 16k budget + demote-instead-of-drop (GH-588 Task 2)', () => {
  let fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  it('G1 under-budget: all full bodies, no alert, ledger bumps every memory', () => {
    // 5x 1000-char bodies total ≈ 5000 chars — comfortably below 16000.
    seedMatchedMemories(
      fixture.storeDir,
      ['a', 'b', 'c', 'd', 'e'],
      [1000, 1000, 1000, 1000, 1000]
    );
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER please', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      assert.match(r.stdout, new RegExp(`SENTINEL-${name}`), `${name} must appear as full body`);
    }
    assert.doesNotMatch(r.stderr, /memories summarized to fit/);
    assert.doesNotMatch(r.stdout, /output truncated at/);
    const ledger = readLedger(fixture.home);
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      assert.equal(injectedCount(ledger, name), 1, `ledger must bump ${name}`);
    }
  });

  it('G2 worked example overflow (8000,6000,6000,1000,5000) → a,b,d full; c,e reminders; alert count=2', () => {
    seedMatchedMemories(
      fixture.storeDir,
      ['a', 'b', 'c', 'd', 'e'],
      [8000, 6000, 6000, 1000, 5000]
    );
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER worked example', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0);
    // a, b, d full bodies present
    assert.match(r.stdout, /SENTINEL-a/);
    assert.match(r.stdout, /SENTINEL-b/);
    assert.match(r.stdout, /SENTINEL-d/);
    // c, e appear as reminder lines (and NOT as full body sentinels)
    assert.match(r.stdout, /\[synapsys:active\] c \(fired earlier; full body in this session\)/);
    assert.match(r.stdout, /\[synapsys:active\] e \(fired earlier; full body in this session\)/);
    assert.doesNotMatch(r.stdout, /SENTINEL-c/);
    assert.doesNotMatch(r.stdout, /SENTINEL-e/);
    // Stderr alert with exact count and budget
    assert.match(
      r.stderr,
      /\[synapsys\] 2 memories summarized to fit 16000-char budget — they will inject in full on next match\./
    );
    // No truncation trailer
    assert.doesNotMatch(r.stdout, /output truncated at/);
    // Ledger bumps only a, b, d
    const ledger = readLedger(fixture.home);
    assert.equal(injectedCount(ledger, 'a'), 1);
    assert.equal(injectedCount(ledger, 'b'), 1);
    assert.equal(injectedCount(ledger, 'd'), 1);
    assert.equal(injectedCount(ledger, 'c'), 0, 'demoted c must NOT bump ledger');
    assert.equal(injectedCount(ledger, 'e'), 0, 'demoted e must NOT bump ledger');
  });

  it('G3 single 18000-char memory: full body emitted, no truncation trailer, no demotion alert, ledger bumped', () => {
    seedMatchedMemories(fixture.storeDir, ['big'], [18000]);
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER big one', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /SENTINEL-big/, 'full body must be present');
    assert.ok(r.stdout.length > 16000, `stdout length ${r.stdout.length} must exceed 16000`);
    assert.doesNotMatch(r.stdout, /output truncated at/);
    assert.doesNotMatch(r.stderr, /memories summarized to fit/);
    const ledger = readLedger(fixture.home);
    assert.equal(injectedCount(ledger, 'big'), 1);
  });

  it('G4 skip threshold: 1500-char memory is never demoted even alongside a 9000-char one', () => {
    // 9000 + 1500 = 10500 — fits under 16k anyway, but the 1500 must remain full.
    seedMatchedMemories(fixture.storeDir, ['big', 'small'], [9000, 1500]);
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER skip threshold', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /SENTINEL-small/, '1500-char memory must be full body');
    // Whichever path big takes (full or reminder), the small one must never
    // appear as a reminder line — that's the skip threshold guarantee.
    assert.doesNotMatch(
      r.stdout,
      /\[synapsys:active\] small \(fired earlier; full body in this session\)/
    );
  });

  it('G5 demotion does not bump ledger; demoted memory injects full on next match', () => {
    // fire_mode: once + two 9000-char memories. Round 1: total 18000 > 16000,
    // reverse-walk demotes m2 (m1 stays full because rotation guarantee +
    // reverse order). Round 2: decideInjection sees m1.count=1 → reminder,
    // m2.count=0 → full. Total = full(m2≈9000) + reminderLine(m1) ≈ 9100,
    // well under 16000 → no demotion → m2 emitted in FULL, proving rotation.
    seedMatchedMemories(fixture.storeDir, ['m1', 'm2'], [9000, 9000], { fireMode: 'once' });
    const round1 = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER round1', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(round1.status, 0);
    assert.match(round1.stderr, /memories summarized to fit/);
    assert.match(round1.stdout, /SENTINEL-m1/, 'm1 full body in round 1');
    assert.match(
      round1.stdout,
      /\[synapsys:active\] m2 \(fired earlier; full body in this session\)/,
      'm2 demoted to reminder in round 1'
    );
    const ledger1 = readLedger(fixture.home);
    assert.equal(injectedCount(ledger1, 'm1'), 1, 'm1 full → ledger bump');
    assert.equal(injectedCount(ledger1, 'm2'), 0, 'm2 demoted → no ledger bump');

    // Round 2 — same matched set, same session
    const round2 = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER round2', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(round2.status, 0);
    assert.doesNotMatch(round2.stderr, /memories summarized to fit/, 'round 2 fits — no alert');
    assert.match(round2.stdout, /SENTINEL-m2/, 'm2 now injects FULL (rotation guarantee)');
    assert.match(
      round2.stdout,
      /\[synapsys:active\] m1 \(fired earlier; full body in this session\)/,
      'm1 now reminder via decideInjection (once + count=1)'
    );
    const ledger2 = readLedger(fixture.home);
    assert.equal(injectedCount(ledger2, 'm2'), 1, 'm2 full in round 2 → ledger bump');
  });

  it('G6 decideInjection-driven reminder still bumps the ledger; stderr lacks demotion alert', () => {
    // fire_mode: once + ledger.injectedCount=1 forces reminder regardless of
    // budget. Single small memory so the budget pass has nothing to demote.
    writeMemory(
      fixture.storeDir,
      'y.md',
      {
        name: 'y',
        description: 'reminder-path memory',
        events: 'UserPromptSubmit',
        trigger_prompt: 'BUDGETTRIGGER',
        inject: 'full',
        fire_mode: 'once',
      },
      makeBody('SENTINEL-y', 1000)
    );
    // Pre-seed ledger so decideInjection picks the reminder branch.
    const sessionDir = path.join(fixture.home, '.claude', 'synapsys', '.session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${SESSION_ID}.json`),
      JSON.stringify({
        createdAt: Date.now(),
        sessionId: SESSION_ID,
        memories: { y: { injectedCount: 1, lastFullInjectAt: 1 } },
      })
    );
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER reminder-path', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[synapsys:active\] y \(fired earlier; full body in this session\)/);
    assert.doesNotMatch(r.stderr, /memories summarized to fit/);
    const ledger = readLedger(fixture.home);
    assert.equal(injectedCount(ledger, 'y'), 2, 'decideInjection reminder must bump ledger');
  });

  it('G7 reverse-walk order: 3 equally-sized demotable memories → m1 full, m2+m3 reminders, alert count=2', () => {
    // Size each body so 3*full > budget AND 2*full > budget after one demotion,
    // forcing two reverse-walk demotions (m3 then m2) to land under 16000.
    seedMatchedMemories(fixture.storeDir, ['m1', 'm2', 'm3'], [8500, 8500, 8500]);
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER reverse-walk', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /SENTINEL-m1/);
    assert.doesNotMatch(r.stdout, /SENTINEL-m2/);
    assert.doesNotMatch(r.stdout, /SENTINEL-m3/);
    assert.match(r.stdout, /\[synapsys:active\] m2 \(fired earlier; full body in this session\)/);
    assert.match(r.stdout, /\[synapsys:active\] m3 \(fired earlier; full body in this session\)/);
    assert.match(r.stderr, /\[synapsys\] 2 memories summarized to fit 16000-char budget/);
  });

  it('G8 E2E hook invocation: exit 0; stdout contains both full bodies and summary lines; stderr begins with [synapsys]', () => {
    seedMatchedMemories(
      fixture.storeDir,
      ['a', 'b', 'c', 'd', 'e'],
      [8000, 6000, 6000, 1000, 5000]
    );
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER e2e', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.length > 0, 'stdout must be non-empty');
    // Both rendering modes present.
    assert.match(r.stdout, /SENTINEL-a/, 'full body present');
    assert.match(r.stdout, /fired earlier; full body in this session/, 'summary line present');
    // Stderr begins with [synapsys].
    assert.ok(r.stderr.startsWith('[synapsys]'), `stderr must start with [synapsys], got ${JSON.stringify(r.stderr.slice(0, 40))}`);
  });

  it('R11 SYNAPSYS_DEBUG=1 emits "[synapsys:debug] budget <used>/<limit>" to stderr', () => {
    seedMatchedMemories(fixture.storeDir, ['a', 'b'], [3000, 3000]);
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER debug', fixture.cwd),
      home: fixture.home,
      env: { SYNAPSYS_DEBUG: '1' },
    });
    assert.equal(r.status, 0);
    assert.match(
      r.stderr,
      /\[synapsys:debug\] budget \d+\/16000/,
      'debug line must report used/limit'
    );
  });

  it('R12 SYNAPSYS_INJECT_BUDGET=24000 override: alert text reads "to fit 24000-char budget"', () => {
    // Three 7000 memories = 21000 chars. Under the default 16000 budget the
    // dispatcher would demote two; under a 24000 budget all three fit full.
    // To still force a demotion at budget=24000, bump to 9000 each = 27000.
    seedMatchedMemories(fixture.storeDir, ['m1', 'm2', 'm3'], [9000, 9000, 9000]);
    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('BUDGETTRIGGER override', fixture.cwd),
      home: fixture.home,
      env: { SYNAPSYS_INJECT_BUDGET: '24000' },
    });
    assert.equal(r.status, 0);
    assert.match(
      r.stderr,
      /memories summarized to fit 24000-char budget/,
      'alert must reflect the overridden budget'
    );
    assert.doesNotMatch(r.stderr, /16000-char budget/, 'alert must NOT mention the default budget');
  });
});

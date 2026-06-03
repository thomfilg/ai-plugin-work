'use strict';

// Integration tests for the synapsys dispatcher hook wiring the per-session
// inject ledger + decideInjection helper (GH-511 Task 3).
//
// The dispatcher is invoked end-to-end via a child process so the test exercises:
//   - selectForEvent → ledger lookup → decideInjection → render → recordInjection
//   - SessionStart resets the ledger
//   - Fail-open behavior when ledger module throws on read
//
// Each test runs in an isolated tmp HOME so per-session ledger files do not leak.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');

function writeMemory(dir, file, frontmatter, body) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, file), `---\n${fm}\n---\n${body}`);
}

function runDispatcher({ event, payload, home, env = {} }) {
  const res = spawnSync(process.execPath, [DISPATCHER, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      SYNAPSYS_NO_SETUP_HINT: '1',
      ...env,
    },
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

function setupFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-fire-mode-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'local', projectName: 'fire-mode-fixture', schemaVersion: 1 })
  );
  return { base, home, cwd, storeDir };
}

const SESSION_ID = 'fire-mode-session-abc';

function promptPayload(prompt, cwd) {
  return { cwd, session_id: SESSION_ID, prompt };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('dispatcher fire_mode wiring (Task 3)', () => {
  let fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  it('P0 #5 once — first match injects full, second match injects reminder', () => {
    writeMemory(
      fixture.storeDir,
      'follow-up.md',
      {
        name: 'follow-up-policy',
        description: 'follow up after push',
        events: 'UserPromptSubmit',
        trigger_prompt: 'follow ?up',
        inject: 'full',
        fire_mode: 'once',
      },
      'BODY-FOLLOW-UP-POLICY-TEXT'
    );

    const first = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('please followup on the PR', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(first.status, 0, `first run failed: ${first.stderr}`);
    assert.match(first.stdout, /BODY-FOLLOW-UP-POLICY-TEXT/, 'first match must emit full body');

    const second = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('another followup', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(second.status, 0);
    assert.equal(
      second.stdout,
      '[synapsys:active] follow-up-policy (fired earlier; full body in this session)',
      'second match must emit the exact reminder line (no path, no body, no trailing newline)'
    );
    assert.doesNotMatch(
      second.stdout,
      /BODY-FOLLOW-UP-POLICY-TEXT/,
      'second match must NOT contain full body'
    );
  });

  it('P0 #5 always — every match injects the full body', () => {
    writeMemory(
      fixture.storeDir,
      'safety.md',
      {
        name: 'never-overclaim-completion',
        description: 'safety-critical',
        events: 'UserPromptSubmit',
        trigger_prompt: 'done',
        inject: 'full',
        fire_mode: 'always',
      },
      'ALWAYS-BODY-DO-NOT-OVERCLAIM'
    );

    for (let i = 0; i < 3; i++) {
      const r = runDispatcher({
        event: 'UserPromptSubmit',
        payload: promptPayload(`task ${i} done`, fixture.cwd),
        home: fixture.home,
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /ALWAYS-BODY-DO-NOT-OVERCLAIM/, `iteration ${i} must emit full body`);
      assert.doesNotMatch(
        r.stdout,
        /fired earlier; full body in this session/,
        `iteration ${i} must NOT emit reminder for fire_mode: always`
      );
    }
  });

  it('P0 #5 occasionally cadence — full at boundary, reminder in between', () => {
    writeMemory(
      fixture.storeDir,
      'cadence.md',
      {
        name: 'occasional-memory',
        description: 'cadence test',
        events: 'UserPromptSubmit',
        trigger_prompt: 'ping',
        inject: 'full',
        fire_mode: 'occasionally',
        fire_cadence: 3,
      },
      'OCCASIONAL-BODY-PING'
    );

    const outputs = [];
    for (let i = 0; i < 4; i++) {
      const r = runDispatcher({
        event: 'UserPromptSubmit',
        payload: promptPayload(`ping ${i}`, fixture.cwd),
        home: fixture.home,
      });
      assert.equal(r.status, 0);
      outputs.push(r.stdout);
    }
    // count==0 → full, count==1 → reminder, count==2 → reminder, count==3 → full
    assert.match(outputs[0], /OCCASIONAL-BODY-PING/, 'count 0 must be full body');
    assert.equal(
      outputs[1],
      '[synapsys:active] occasional-memory (fired earlier; full body in this session)',
      'count 1 must be reminder'
    );
    assert.equal(
      outputs[2],
      '[synapsys:active] occasional-memory (fired earlier; full body in this session)',
      'count 2 must be reminder'
    );
    assert.match(outputs[3], /OCCASIONAL-BODY-PING/, 'count 3 must be full body (cadence boundary)');
  });

  it('P0 #4 SessionStart resets the ledger', () => {
    writeMemory(
      fixture.storeDir,
      'once-reset.md',
      {
        name: 'reset-me',
        description: 'reset on session start',
        events: 'UserPromptSubmit',
        trigger_prompt: 'kick',
        inject: 'full',
        fire_mode: 'once',
      },
      'RESET-MEMORY-BODY'
    );

    const first = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('kick it', fixture.cwd),
      home: fixture.home,
    });
    assert.match(first.stdout, /RESET-MEMORY-BODY/);

    const second = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('kick again', fixture.cwd),
      home: fixture.home,
    });
    assert.match(
      second.stdout,
      /fired earlier; full body in this session/,
      'before reset: second match must be reminder'
    );

    // SessionStart should reset the ledger
    runDispatcher({
      event: 'SessionStart',
      payload: { cwd: fixture.cwd, session_id: SESSION_ID },
      home: fixture.home,
    });

    const afterReset = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('kick post-reset', fixture.cwd),
      home: fixture.home,
    });
    assert.match(
      afterReset.stdout,
      /RESET-MEMORY-BODY/,
      'after SessionStart reset: next match must inject full body again'
    );
    assert.doesNotMatch(
      afterReset.stdout,
      /fired earlier; full body in this session/,
      'after reset, output must NOT be a reminder'
    );
  });

  it('Constraint — ledger read error falls open to full inject', () => {
    writeMemory(
      fixture.storeDir,
      'fail-open.md',
      {
        name: 'fail-open-mem',
        description: 'fail-open',
        events: 'UserPromptSubmit',
        trigger_prompt: 'boom',
        inject: 'full',
        fire_mode: 'once',
      },
      'FAIL-OPEN-BODY'
    );

    // Simulate ledger-load throwing. We shim `inject-ledger.js` in the spawned
    // dispatcher's NODE_PATH-equivalent via SYNAPSYS_LEDGER_INJECT_FAULT. The
    // dispatcher reads no such env, so instead we use the on-disk approach
    // ("re-poison before each call"): write an unreadable / corrupt ledger
    // file before each dispatcher invocation, and verify that the dispatcher
    // emits the full body each time. Because `recordInjection` itself runs
    // inside the dispatcher's catch, a write failure must NOT change output.
    const sessionDir = path.join(fixture.home, '.claude', 'synapsys', '.session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const ledgerFile = path.join(sessionDir, `${SESSION_ID}.json`);

    function poisonLedger() {
      // Corrupt JSON forces `loadLedger` into its catch → empty ledger. But to
      // simulate a true read-error (R1 contract: "any error in ledger lookup …
      // falls through to full inject"), we instead make the ledger file a
      // directory: every fs.readFileSync / fs.statSync.isFile() call throws,
      // and recordInjection's saveLedger also fails. Result: count stays 0
      // forever → fire_mode: once always renders the full body.
      try {
        fs.rmSync(ledgerFile, { recursive: true, force: true });
      } catch {
        /* noop */
      }
      fs.mkdirSync(ledgerFile, { recursive: true });
    }

    for (let i = 0; i < 2; i++) {
      poisonLedger();
      const r = runDispatcher({
        event: 'UserPromptSubmit',
        payload: promptPayload('boom ' + i, fixture.cwd),
        home: fixture.home,
      });
      assert.equal(r.status, 0, `iteration ${i} must exit 0 (fail-open)`);
      assert.match(
        r.stdout,
        /FAIL-OPEN-BODY/,
        `iteration ${i} must inject full body when ledger lookup errors`
      );
    }
  });

  it('Brief success metric — follow-up policy is injected at most once per cascade session', () => {
    // Mirror the brief's headline scenario: a single session, three UserPromptSubmit
    // invocations all matching `follow-up-policy` (fire_mode: once). Exactly one
    // full-body inject; the remaining two must be the reminder line.
    writeMemory(
      fixture.storeDir,
      'follow-up.md',
      {
        name: 'follow-up-policy',
        description: 'cascade follow-up',
        events: 'UserPromptSubmit',
        trigger_prompt: 'follow ?up',
        inject: 'full',
        fire_mode: 'once',
      },
      'CASCADE-FULL-BODY-FOLLOWUP'
    );

    const outputs = [];
    for (let i = 0; i < 3; i++) {
      const r = runDispatcher({
        event: 'UserPromptSubmit',
        payload: promptPayload(`followup turn ${i}`, fixture.cwd),
        home: fixture.home,
      });
      assert.equal(r.status, 0);
      outputs.push(r.stdout);
    }
    const fullCount = outputs.filter((o) => /CASCADE-FULL-BODY-FOLLOWUP/.test(o)).length;
    const reminderCount = outputs.filter((o) =>
      /^\[synapsys:active\] follow-up-policy \(fired earlier; full body in this session\)$/.test(o)
    ).length;
    assert.equal(fullCount, 1, 'full body must be injected exactly once per cascade session');
    assert.equal(reminderCount, 2, 'remaining matches must be reminders');
  });
});

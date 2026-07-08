'use strict';

/**
 * Dispatcher codex JSON-sniff guard (WP-12 scenario B fix).
 *
 * On codex, exit-0 stdout whose first non-whitespace char is `{`/`[`/`"` is
 * sniffed as JSON; the synapsys injection headers ('[synapsys:local]',
 * '[synapsys:active]', '[synapsys:setup-required]') are bracket-leading, so
 * the parse fails, the hook is marked Failed, and the injection is DROPPED
 * (live-proven: /tmp/codex-wp12-logs scenario B + recon probes). The fix
 * prepends the CODEX_STDOUT_LEAD_IN line on codex only.
 *
 * Claude byte-parity is pinned separately by dispatcher-golden.test.js — this
 * file asserts the codex branch AND that the guarded payload is verbatim
 * below the lead-in.
 *
 * Run: node --test plugins/synapsys/lib/__tests__/dispatcher-codex-guard.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');
const { CODEX_STDOUT_LEAD_IN } = require('../runtime/emit');

const MEMORY_NAME = 'codex-guard-memory';
const KNOWN_PROMPT = 'codex guard dispatcher regression prompt';
const MEMORY_BODY = 'Codex guard body line one.\nCodex guard body line two.';
const MEMORY_DESCRIPTION = 'Codex guard regression memory.';

function makeFixtureStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-codex-guard-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'codex-guard-fixture' })
  );
  fs.writeFileSync(
    path.join(storeDir, `${MEMORY_NAME}.md`),
    [
      '---',
      `name: ${MEMORY_NAME}`,
      `description: ${MEMORY_DESCRIPTION}`,
      'events: UserPromptSubmit',
      'trigger_prompt: codex guard dispatcher',
      'trigger_session: false',
      'inject: full',
      '---',
      '',
      MEMORY_BODY,
      '',
    ].join('\n')
  );
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function runDispatcher(event, payload, extraEnv) {
  return spawnSync(process.execPath, [DISPATCHER, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      SYNAPSYS_CORTEX_AUTO_RECALL: 'off',
      ...extraEnv,
    },
  });
}

test('codex UserPromptSubmit injection gains the lead-in; payload verbatim below it', (t) => {
  const { cwd, cleanup } = makeFixtureStore();
  const sessionTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-codex-guard-session-'));
  t.after(() => {
    cleanup();
    fs.rmSync(sessionTmp, { recursive: true, force: true });
  });

  const result = runDispatcher(
    'UserPromptSubmit',
    { hook_event_name: 'UserPromptSubmit', prompt: KNOWN_PROMPT, cwd },
    {
      AGENT_RUNTIME: 'codex',
      SYNAPSYS_NO_SETUP_HINT: '1',
      SYNAPSYS_SESSION_DIR: sessionTmp,
    }
  );

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  const expectedBody = `[synapsys:local] ${MEMORY_NAME} — ${MEMORY_DESCRIPTION}\n\n${MEMORY_BODY}`;
  assert.equal(
    result.stdout,
    `${CODEX_STDOUT_LEAD_IN}\n${expectedBody}`,
    'codex stdout must be lead-in + verbatim claude injection'
  );
});

test('codex SessionStart setup hint (bracket-leading literal) is guarded too', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-codex-guard-nostore-'));
  const sessionTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-codex-guard-session2-'));
  // Hermetic HOME: the real user HOME can carry global/shared synapsys stores,
  // which would suppress the setup-required hint (stores.length > 0).
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-codex-guard-home-'));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(sessionTmp, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  const env = {
    AGENT_RUNTIME: 'codex',
    SYNAPSYS_SESSION_DIR: sessionTmp,
    HOME: fakeHome,
    // The hint must actually render: unset the suppressor if inherited.
    SYNAPSYS_NO_SETUP_HINT: '',
  };
  const result = runDispatcher(
    'SessionStart',
    { hook_event_name: 'SessionStart', cwd, source: 'startup' },
    env
  );

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  const lines = result.stdout.split('\n');
  assert.equal(lines[0], CODEX_STDOUT_LEAD_IN, 'hint must start with the lead-in on codex');
  assert.match(lines[1], /^\[synapsys:setup-required\]/);
});

test('claude UserPromptSubmit injection stays bracket-leading (no lead-in)', (t) => {
  const { cwd, cleanup } = makeFixtureStore();
  const sessionTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-codex-guard-session3-'));
  t.after(() => {
    cleanup();
    fs.rmSync(sessionTmp, { recursive: true, force: true });
  });

  const result = runDispatcher(
    'UserPromptSubmit',
    { hook_event_name: 'UserPromptSubmit', prompt: KNOWN_PROMPT, cwd },
    {
      AGENT_RUNTIME: 'claude',
      SYNAPSYS_NO_SETUP_HINT: '1',
      SYNAPSYS_SESSION_DIR: sessionTmp,
    }
  );

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  assert.match(result.stdout, /^\[synapsys:local\] codex-guard-memory/);
});

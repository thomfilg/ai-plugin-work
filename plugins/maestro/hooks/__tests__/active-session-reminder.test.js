'use strict';

/**
 * active-session-reminder.js — per-runtime stdout contract.
 *
 * WP-12 TUI probe: the '[maestro] …' banner is bracket-leading, so codex
 * sniffs the hook stdout as JSON, fails to parse, marks the hook Failed and
 * DROPS the injection ("hook returned invalid user prompt submit JSON
 * output"). The fix routes the banner through guardStdoutContext: codex gets
 * a 'hook context:' lead-in line; claude bytes stay byte-identical.
 *
 * Run: node --test plugins/maestro/hooks/__tests__/active-session-reminder.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'active-session-reminder.js');
const { CODEX_STDOUT_LEAD_IN } = require('../../scripts/lib/runtime/emit');

let sessionDir;
let alertFile;

before(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-reminder-'));
  alertFile = path.join(sessionDir, 'alerts.jsonl');
  fs.writeFileSync(
    path.join(sessionDir, 'topic-a.json'),
    JSON.stringify({
      topic: 'topic-a',
      slots: 2,
      tasks: [
        { id: 'GH-1', status: 'done', priority: 1 },
        { id: 'GH-2', status: 'in_progress', priority: 2 },
        { id: 'GH-3', status: 'pending', priority: 3, deps: ['GH-1'] },
      ],
    })
  );
});

after(() => {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function runHook(extraEnv) {
  return spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify({ cwd: process.cwd(), hook_event_name: 'UserPromptSubmit' }),
    env: {
      ...process.env,
      MAESTRO_SESSION_DIR: sessionDir,
      ALERT_FILE: alertFile,
      AGENT_RUNTIME: 'claude',
      ...extraEnv,
    },
  });
}

describe('active-session-reminder per-runtime stdout', () => {
  it('claude: banner is emitted verbatim, bracket-leading', () => {
    const res = runHook({});
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^\[maestro\] ACTIVE ORCHESTRATION SESSION\(S\)/);
    assert.match(res.stdout, /topic-a — slots=2/);
  });

  it('codex: identical banner is preceded by the JSON-sniff lead-in line', () => {
    const res = runHook({ AGENT_RUNTIME: 'codex' });
    assert.equal(res.status, 0);
    const lines = res.stdout.split('\n');
    assert.equal(lines[0], CODEX_STDOUT_LEAD_IN);
    assert.match(lines[1], /^\[maestro\] ACTIVE ORCHESTRATION SESSION\(S\)/);
  });

  it('codex payload sniff (turn_id) also triggers the guard without the env pin', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      input: JSON.stringify({
        cwd: process.cwd(),
        hook_event_name: 'UserPromptSubmit',
        turn_id: '019f3ddc-fdc4-7bc1-832f-9f6d93b1ff60',
      }),
      env: {
        ...process.env,
        MAESTRO_SESSION_DIR: sessionDir,
        ALERT_FILE: alertFile,
        AGENT_RUNTIME: '',
      },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.split('\n')[0], CODEX_STDOUT_LEAD_IN);
  });

  it('no manifests: silent exit 0 on both runtimes', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-reminder-empty-'));
    try {
      const res = runHook({ MAESTRO_SESSION_DIR: empty, AGENT_RUNTIME: 'codex' });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

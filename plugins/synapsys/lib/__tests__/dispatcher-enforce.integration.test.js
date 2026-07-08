'use strict';

// Integration tests for GH-520 per-memory enforce mode (advise|suggest|block)
// on the PreToolUse dispatch path. Spawns the dispatcher end-to-end (same
// harness as dispatcher-pretool-injection.integration.test.js) in an isolated
// tmp HOME.
//
// Covers:
//   - block deny envelope + structured message format
//   - override marker (reason >= 10 chars) allows + logs an `override` event
//   - override reason < 10 chars still denies (with a too-short notice)
//   - suggest appends the one-line nudge (never blocks)
//   - unknown enforce_classifier → advise fallback + stderr warning
//   - symbol-shape classifier allow/block cases
//   - first-edit-of-session classifier (satisfier seen → allow; not seen →
//     deny first edit only)

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

function runDispatcher({ event = 'PreToolUse', payload, home, env = {} }) {
  const res = spawnSync(process.execPath, [DISPATCHER, event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      SYNAPSYS_NO_SETUP_HINT: '1',
      // Pin telemetry ON and make sure a live CLAUDE_CODE_SESSION_ID never
      // leaks in — telemetry/session state must key off payload.session_id.
      SYNAPSYS_TELEMETRY: '1',
      CLAUDE_CODE_SESSION_ID: '',
      ...env,
    },
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

function setupFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-enforce-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'local', projectName: 'enforce-fixture', schemaVersion: 1 })
  );
  return { base, home, cwd, storeDir };
}

function readTelemetry(home, sessionId) {
  const file = path.join(home, '.claude', 'synapsys', '.telemetry', `${sessionId}.jsonl`);
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function parseEnvelope(stdout) {
  assert.notEqual(stdout, '', 'expected dispatcher to emit hook JSON, got empty stdout');
  const parsed = JSON.parse(stdout);
  assert.equal(typeof parsed.hookSpecificOutput, 'object');
  return parsed.hookSpecificOutput;
}

function assertDeny(stdout, memoryName) {
  const out = parseEnvelope(stdout);
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny', `expected a deny, got: ${stdout.slice(0, 200)}`);
  assert.equal(
    out.additionalContext,
    undefined,
    'a deny response must NOT mix in additionalContext'
  );
  assert.match(out.permissionDecisionReason, new RegExp(`^\\[synapsys:block\\] ${memoryName}\\n`));
  return out;
}

function assertAllow(stdout) {
  const out = parseEnvelope(stdout);
  assert.equal(out.permissionDecision, undefined, `unexpected deny: ${stdout.slice(0, 200)}`);
  assert.equal(typeof out.additionalContext, 'string');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('dispatcher enforce mode (GH-520)', () => {
  let fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  function writeBlockPushMemory(extra = {}, body = 'BLOCK-PUSH-BODY') {
    writeMemory(
      fixture.storeDir,
      'push-block.md',
      {
        name: 'push-block',
        description: 'block direct pushes',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:git\\s+push',
        inject: 'full',
        enforce: 'block',
        ...extra,
      },
      body
    );
  }

  function bashPayload(command, sessionId) {
    return {
      cwd: fixture.cwd,
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command },
    };
  }

  // ── block deny envelope + message format ────────────────────────────────────

  it('enforce: block emits the deny envelope with the structured message', () => {
    writeBlockPushMemory();
    const sid = 'enf-block-1';
    const r = runDispatcher({
      payload: bashPayload('git push origin main', sid),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);

    const out = assertDeny(r.stdout, 'push-block');
    const msg = out.permissionDecisionReason;
    assert.match(msg, /BLOCK-PUSH-BODY/, 'message must carry the trimmed memory body');
    assert.match(msg, /To override, re-issue the SAME tool call including the marker:/);
    assert.match(msg, /# synapsys:override=push-block reason="<10\+ char reason>"/);
    assert.match(
      msg,
      /\(in the Bash command or the tool's description field\)\. Overrides are per-call and logged\./
    );

    const events = readTelemetry(fixture.home, sid);
    const block = events.find((e) => e.event === 'block');
    assert.ok(block, `expected a block telemetry event, got: ${JSON.stringify(events)}`);
    assert.equal(block.memory, 'push-block');
    assert.equal(block.tool, 'Bash');
  });

  // ── override marker ─────────────────────────────────────────────────────────

  it('override marker with a >=10 char reason allows the call and logs an override event', () => {
    writeBlockPushMemory();
    const sid = 'enf-override-1';
    const r = runDispatcher({
      payload: bashPayload(
        'git push origin main # synapsys:override=push-block reason="deploy window approved by ops"',
        sid
      ),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);

    const out = assertAllow(r.stdout);
    assert.match(
      out.additionalContext,
      /BLOCK-PUSH-BODY/,
      'overridden call keeps the advise injection'
    );

    const events = readTelemetry(fixture.home, sid);
    const override = events.find((e) => e.event === 'override');
    assert.ok(override, `expected an override telemetry event, got: ${JSON.stringify(events)}`);
    assert.equal(override.memory, 'push-block');
    assert.equal(override.reason, 'deploy window approved by ops');
    assert.ok(!events.some((e) => e.event === 'block'), 'no block event on a valid override');
  });

  it('override reason < 10 chars still denies, with a too-short notice', () => {
    writeBlockPushMemory();
    const sid = 'enf-short-1';
    const r = runDispatcher({
      payload: bashPayload(
        'git push origin main # synapsys:override=push-block reason="short"',
        sid
      ),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    const out = assertDeny(r.stdout, 'push-block');
    assert.match(out.permissionDecisionReason, /reason is too short/);
    const events = readTelemetry(fixture.home, sid);
    assert.ok(
      events.some((e) => e.event === 'block'),
      'short-reason override still logs a block'
    );
  });

  it('override naming a DIFFERENT memory does not lift the block', () => {
    writeBlockPushMemory();
    const r = runDispatcher({
      payload: bashPayload(
        'git push origin main # synapsys:override=other-memory reason="a perfectly long reason"',
        'enf-wrongname-1'
      ),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    assertDeny(r.stdout, 'push-block');
  });

  // ── suggest ─────────────────────────────────────────────────────────────────

  it('enforce: suggest appends the one-line nudge and never blocks', () => {
    writeMemory(
      fixture.storeDir,
      'push-suggest.md',
      {
        name: 'push-suggest',
        description: 'suggest an alternative to pushing',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:git\\s+push',
        inject: 'full',
        enforce: 'suggest',
      },
      'SUGGEST-PUSH-BODY'
    );
    const r = runDispatcher({
      payload: bashPayload('git push origin main', 'enf-suggest-1'),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    const out = assertAllow(r.stdout);
    assert.match(out.additionalContext, /SUGGEST-PUSH-BODY/);
    assert.match(
      out.additionalContext,
      /\[synapsys:suggest\] push-suggest — consider the recommended alternative before proceeding \(see memory above\)/
    );
  });

  // ── unknown classifier → advise fallback ────────────────────────────────────

  it('unknown enforce_classifier falls back to advise with a stderr warning', () => {
    writeBlockPushMemory({ enforce_classifier: 'no-such-classifier' });
    const r = runDispatcher({
      payload: bashPayload('git push origin main', 'enf-unknown-1'),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    const out = assertAllow(r.stdout);
    assert.match(out.additionalContext, /BLOCK-PUSH-BODY/, 'advise injection must still happen');
    assert.match(r.stderr, /unknown enforce_classifier "no-such-classifier"/);
  });

  // ── symbol-shape classifier ─────────────────────────────────────────────────

  function writeSymbolShapeMemory(trigger) {
    writeMemory(
      fixture.storeDir,
      'use-codegraph.md',
      {
        name: 'use-codegraph',
        description: 'use codegraph for symbol lookups',
        events: 'PreToolUse',
        trigger_pretool: trigger,
        inject: 'full',
        enforce: 'block',
        enforce_classifier: 'symbol-shape',
      },
      'USE-CODEGRAPH-BODY'
    );
  }

  function grepPayload(pattern, extraInput, sessionId) {
    return {
      cwd: fixture.cwd,
      session_id: sessionId,
      tool_name: 'Grep',
      tool_input: { pattern, ...extraInput },
    };
  }

  it('symbol-shape blocks an identifier-shaped Grep pattern', () => {
    writeSymbolShapeMemory('Grep:');
    const r = runDispatcher({
      payload: grepPayload('getUserData', { path: 'src' }, 'enf-sym-block-1'),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    assertDeny(r.stdout, 'use-codegraph');
  });

  it('symbol-shape allows patterns with spaces, $, regex metachars, and .md targets', () => {
    writeSymbolShapeMemory('Grep:');
    const cases = [
      grepPayload('get user data', {}, 'enf-sym-a1'), // spaces
      grepPayload('user$Data', {}, 'enf-sym-a2'), // $ (regex anchor char)
      grepPayload('get.*Data', {}, 'enf-sym-a3'), // regex metachars
      grepPayload('getUserData', { path: 'docs/notes.md' }, 'enf-sym-a4'), // .md target
      grepPayload('getUserData', { glob: 'node_modules/**' }, 'enf-sym-a5'), // vendor target
      grepPayload('TODO', {}, 'enf-sym-a6'), // stoplist
      grepPayload('ab', {}, 'enf-sym-a7'), // too short
    ];
    for (const payload of cases) {
      const r = runDispatcher({ payload, home: fixture.home });
      assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
      const out = assertAllow(r.stdout);
      assert.match(
        out.additionalContext,
        /use-codegraph/,
        `pattern ${payload.tool_input.pattern} should inject (advise), not block`
      );
    }
  });

  it('symbol-shape handles Bash grep/rg invocations', () => {
    writeSymbolShapeMemory('Bash:\\b(grep|rg)\\b');
    // Identifier pattern → block.
    const blocked = runDispatcher({
      payload: bashPayloadFor('rg -n getUserData src/', 'enf-sym-bash-1'),
      home: fixture.home,
    });
    assert.equal(blocked.status, 0, `dispatcher failed: ${blocked.stderr}`);
    assertDeny(blocked.stdout, 'use-codegraph');

    // Regex pattern → allow.
    const allowed = runDispatcher({
      payload: bashPayloadFor('grep -rn "get.*Data" src/', 'enf-sym-bash-2'),
      home: fixture.home,
    });
    assert.equal(allowed.status, 0, `dispatcher failed: ${allowed.stderr}`);
    assertAllow(allowed.stdout);

    // Identifier but .md target → allow.
    const mdTarget = runDispatcher({
      payload: bashPayloadFor('grep -rn getUserData docs/notes.md', 'enf-sym-bash-3'),
      home: fixture.home,
    });
    assert.equal(mdTarget.status, 0, `dispatcher failed: ${mdTarget.stderr}`);
    assertAllow(mdTarget.stdout);

    function bashPayloadFor(command, sessionId) {
      return {
        cwd: fixture.cwd,
        session_id: sessionId,
        tool_name: 'Bash',
        tool_input: { command },
      };
    }
  });

  // ── first-edit-of-session classifier ────────────────────────────────────────

  function writeFirstEditMemory() {
    writeMemory(
      fixture.storeDir,
      'recall-before-edit.md',
      {
        name: 'recall-before-edit',
        description: 'recall project memory before the first edit',
        events: 'PreToolUse',
        trigger_pretool: 'Edit:',
        inject: 'full',
        enforce: 'block',
        enforce_classifier: 'first-edit-of-session',
        enforce_satisfied_by: 'cortex_recall',
      },
      'RECALL-BEFORE-EDIT-BODY'
    );
  }

  function editPayload(sessionId) {
    return {
      cwd: fixture.cwd,
      session_id: sessionId,
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.js', old_string: 'a', new_string: 'b' },
    };
  }

  it('first-edit-of-session denies only the FIRST edit when no satisfier was seen', () => {
    writeFirstEditMemory();
    const sid = 'enf-firstedit-1';

    const first = runDispatcher({ payload: editPayload(sid), home: fixture.home });
    assert.equal(first.status, 0, `dispatcher failed: ${first.stderr}`);
    assertDeny(first.stdout, 'recall-before-edit');

    // The gate is consumed by the first edit — the second edit is allowed.
    const second = runDispatcher({ payload: editPayload(sid), home: fixture.home });
    assert.equal(second.status, 0, `dispatcher failed: ${second.stderr}`);
    assertAllow(second.stdout);
  });

  it('first-edit-of-session allows the first edit when the satisfier tool was observed', () => {
    writeFirstEditMemory();
    const sid = 'enf-firstedit-2';

    // Observe a satisfier tool call first (matches /cortex_recall/). It does
    // not match the memory's trigger, so no output — but the observer records it.
    const recall = runDispatcher({
      payload: {
        cwd: fixture.cwd,
        session_id: sid,
        tool_name: 'mcp__cortex__cortex_recall',
        tool_input: { query: 'project context' },
      },
      home: fixture.home,
    });
    assert.equal(recall.status, 0, `dispatcher failed: ${recall.stderr}`);

    const edit = runDispatcher({ payload: editPayload(sid), home: fixture.home });
    assert.equal(edit.status, 0, `dispatcher failed: ${edit.stderr}`);
    const out = assertAllow(edit.stdout);
    assert.match(out.additionalContext, /RECALL-BEFORE-EDIT-BODY/);
  });

  // ── first blocking memory wins / deny purity ────────────────────────────────

  it('with multiple matching block memories, the first (memory list order) wins', () => {
    writeMemory(
      fixture.storeDir,
      'a-first-block.md',
      {
        name: 'a-first-block',
        description: 'first block memory',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:git\\s+push',
        inject: 'full',
        enforce: 'block',
      },
      'A-FIRST-BODY'
    );
    writeMemory(
      fixture.storeDir,
      'b-second-block.md',
      {
        name: 'b-second-block',
        description: 'second block memory',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:git\\s+push',
        inject: 'full',
        enforce: 'block',
      },
      'B-SECOND-BODY'
    );
    const r = runDispatcher({
      payload: bashPayload('git push origin main', 'enf-multi-1'),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    const out = assertDeny(r.stdout, 'a-first-block');
    assert.doesNotMatch(out.permissionDecisionReason, /B-SECOND-BODY/);
  });
});

'use strict';

// Integration tests for the synapsys dispatcher hook PreToolUse injection path
// (GH-497 Task 1).
//
// Covers three cohesive cycles on the same code surface:
//   1.1 Event-branched on-match output — PreToolUse emits
//       `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":<render>}}`
//       JSON; UserPromptSubmit stays raw stdout; no-match PreToolUse writes nothing.
//   1.2 collectSubagentMatches — Task/Agent `tool_input.prompt` matches the
//       UserPromptSubmit/SessionStart/Stop matchers and unions into `matched`,
//       deduped by `memory.name`, so prompt-scope memories reach the subagent.
//   1.3 Non-blocking contract — no decision/block/deny in stdout; exit 0 on
//       match and on a forced internal error.
//
// The dispatcher is invoked end-to-end via a child process (mirroring the
// spawnSync harness from dispatcher-fire-mode.integration.test.js), in an
// isolated tmp HOME so per-session ledger files do not leak.

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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-pretool-inject-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'local', projectName: 'pretool-inject-fixture', schemaVersion: 1 })
  );
  return { base, home, cwd, storeDir };
}

// Seed a user DOMAINS.md (takes precedence over the bundled registry) so a
// known prompt token activates a known domain for the classifier.
function writeDomains(home, body) {
  const dir = path.join(home, '.claude', 'synapsys');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'DOMAINS.md'), body);
}

const SESSION_ID = 'pretool-inject-session-abc';

// PreToolUse Bash payload matching a `Bash:git push` trigger_pretool memory.
function bashPushPayload(cwd) {
  return {
    cwd,
    session_id: SESSION_ID,
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
  };
}

function promptPayload(prompt, cwd) {
  return { cwd, session_id: SESSION_ID, prompt };
}

// PreToolUse subagent-spawn payload (Task/Agent) carrying a `tool_input.prompt`.
function subagentPayload(toolName, prompt, cwd) {
  return {
    cwd,
    session_id: SESSION_ID,
    tool_name: toolName,
    tool_input: { prompt },
  };
}

// Parse the dispatcher's PreToolUse on-match stdout as the hook JSON envelope.
// Validate the shape with assertions FIRST so a missing/raw-stdout dispatcher
// surfaces as an AssertionError (the expected RED behavior gap) rather than a
// raw JSON.parse SyntaxError.
function parseHookOutput(stdout) {
  assert.notEqual(stdout, '', 'expected PreToolUse to emit hookSpecificOutput JSON, got empty stdout');
  let parsed;
  let parsedOk = false;
  try {
    parsed = JSON.parse(stdout);
    parsedOk = true;
  } catch {
    parsedOk = false;
  }
  assert.equal(
    parsedOk,
    true,
    `expected PreToolUse stdout to be valid hook JSON, got non-JSON: ${stdout.slice(0, 80)}`
  );
  assert.equal(
    typeof parsed.hookSpecificOutput,
    'object',
    'expected stdout to contain a hookSpecificOutput object'
  );
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('dispatcher PreToolUse injection (GH-497 Task 1)', () => {
  let fixture;

  beforeEach(() => {
    fixture = setupFixture();
  });

  // ── 1.1 Event-branched on-match output ────────────────────────────────────

  it('PreToolUse match is emitted as additionalContext JSON', () => {
    writeMemory(
      fixture.storeDir,
      'push-policy.md',
      {
        name: 'push-policy',
        description: 'check before pushing',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:git\\s+push',
        inject: 'full',
      },
      'PRETOOL-PUSH-POLICY-BODY'
    );

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: bashPushPayload(fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);

    const parsed = parseHookOutput(r.stdout);
    assert.equal(
      parsed.hookSpecificOutput.hookEventName,
      'PreToolUse',
      'hookEventName must be PreToolUse'
    );
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /PRETOOL-PUSH-POLICY-BODY/,
      'additionalContext must carry the matched memory body'
    );
  });

  it('UserPromptSubmit output is unchanged raw stdout', () => {
    writeMemory(
      fixture.storeDir,
      'prompt-policy.md',
      {
        name: 'prompt-policy',
        description: 'follow up after push',
        events: 'UserPromptSubmit',
        trigger_prompt: 'follow ?up',
        inject: 'full',
      },
      'PROMPT-POLICY-BODY'
    );

    const r = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('please followup on the PR', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    assert.match(r.stdout, /PROMPT-POLICY-BODY/, 'raw render must contain the memory body');
    assert.doesNotMatch(
      r.stdout,
      /hookSpecificOutput/,
      'UserPromptSubmit must NOT wrap output in hookSpecificOutput JSON'
    );
  });

  it('No-match PreToolUse emits no output', () => {
    writeMemory(
      fixture.storeDir,
      'push-policy.md',
      {
        name: 'push-policy',
        description: 'check before pushing',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:git\\s+push',
        inject: 'full',
      },
      'PRETOOL-PUSH-POLICY-BODY'
    );

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: {
        cwd: fixture.cwd,
        session_id: SESSION_ID,
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      },
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);
    assert.equal(r.stdout, '', 'no-match PreToolUse must emit empty stdout (no JSON noise)');
  });

  // ── 1.2 collectSubagentMatches + dedupe-by-name ───────────────────────────

  it('PreToolUse Task prompt propagates prompt-scope memories to the subagent', () => {
    writeMemory(
      fixture.storeDir,
      'prompt-scope.md',
      {
        name: 'prompt-scope-policy',
        description: 'prompt-scope memory',
        events: 'UserPromptSubmit',
        trigger_prompt: 'refactor',
        inject: 'full',
      },
      'SUBAGENT-PROMPT-SCOPE-BODY'
    );

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: subagentPayload('Task', 'please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);

    const parsed = parseHookOutput(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /SUBAGENT-PROMPT-SCOPE-BODY/,
      'Task tool_input.prompt match must inject the prompt-scope memory as additionalContext'
    );
  });

  it('PreToolUse Agent prompt is treated like Task', () => {
    writeMemory(
      fixture.storeDir,
      'prompt-scope.md',
      {
        name: 'prompt-scope-policy',
        description: 'prompt-scope memory',
        events: 'UserPromptSubmit',
        trigger_prompt: 'refactor',
        inject: 'full',
      },
      'AGENT-PROMPT-SCOPE-BODY'
    );

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: subagentPayload('Agent', 'please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);

    const parsed = parseHookOutput(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /AGENT-PROMPT-SCOPE-BODY/,
      'Agent tool_input.prompt match must inject the prompt-scope memory as additionalContext'
    );
  });

  it('Memory matching both PreTool and prompt is injected once', () => {
    // This memory fires on BOTH the PreToolUse Task tool (trigger_pretool: Task:)
    // AND the synthetic UserPromptSubmit run over tool_input.prompt
    // (trigger_prompt). It must appear exactly once after dedupe-by-name.
    writeMemory(
      fixture.storeDir,
      'both-scope.md',
      {
        name: 'both-scope-policy',
        description: 'matches pretool and prompt',
        events: 'PreToolUse,UserPromptSubmit',
        trigger_pretool: 'Task:',
        trigger_prompt: 'refactor',
        inject: 'full',
      },
      'BOTH-SCOPE-UNIQUE-BODY'
    );

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: subagentPayload('Task', 'please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);

    const parsed = parseHookOutput(r.stdout);
    const body = parsed.hookSpecificOutput.additionalContext;
    const occurrences = body.split('BOTH-SCOPE-UNIQUE-BODY').length - 1;
    assert.equal(
      occurrences,
      1,
      `a both-matching memory must appear exactly once (saw ${occurrences})`
    );
  });

  // ── 1.2b Bot-flagged regressions (PR #605, Cursor Bugbot) ─────────────────

  // "Wrong domains for subagent prompts": activeDomains must be recomputed from
  // the synthetic prompt payload, not reused from the outer PreToolUse selectOpts
  // (whose payload.prompt is empty → domain-tagged memory wrongly gated out).
  it('domain-tagged prompt memory propagates to subagent when synthetic prompt activates the domain', () => {
    writeDomains(fixture.home, 'root: testdom\n  leaf: l1\n    signal_prompt: \\brefactor\\b\n');
    writeMemory(
      fixture.storeDir,
      'domain-scope.md',
      {
        name: 'domain-scope-policy',
        description: 'domain-tagged prompt memory',
        events: 'UserPromptSubmit',
        trigger_prompt: 'refactor',
        domain: 'testdom',
        inject: 'full',
      },
      'DOMAIN-SCOPE-BODY'
    );

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: subagentPayload('Task', 'please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);

    const parsed = parseHookOutput(r.stdout);
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      /DOMAIN-SCOPE-BODY/,
      'domain-tagged memory must inject when the subagent prompt activates its domain'
    );
  });

  // "Stop matcher spurious subagent injection": a Stop-scope memory with no
  // trigger_stop_response fires unconditionally on the Stop matcher; it must NOT
  // be propagated into a subagent spawn (Stop is excluded from the loop).
  it('Stop-scope memory is NOT propagated to a subagent spawn', () => {
    writeMemory(
      fixture.storeDir,
      'prompt-scope.md',
      {
        name: 'prompt-scope-policy',
        description: 'prompt-scope memory that should inject',
        events: 'UserPromptSubmit',
        trigger_prompt: 'refactor',
        inject: 'full',
      },
      'SUBAGENT-PROMPT-SCOPE-BODY'
    );
    writeMemory(
      fixture.storeDir,
      'stop-scope.md',
      {
        name: 'stop-scope-policy',
        description: 'end-of-turn Stop policy — must not reach subagents',
        events: 'Stop',
        inject: 'full',
      },
      'STOP-SCOPE-BODY'
    );

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: subagentPayload('Task', 'please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `dispatcher failed: ${r.stderr}`);

    const parsed = parseHookOutput(r.stdout);
    const body = parsed.hookSpecificOutput.additionalContext;
    assert.match(body, /SUBAGENT-PROMPT-SCOPE-BODY/, 'prompt-scope memory must still inject');
    assert.doesNotMatch(
      body,
      /STOP-SCOPE-BODY/,
      'end-of-turn Stop policy must NOT be injected into a subagent spawn'
    );
  });

  // "Subagent context uses reminder ledger": a `once` memory already injected
  // full in this session (via UserPromptSubmit) must still render its FULL body
  // when propagated to a subagent spawn — the subagent is a fresh context that
  // has never seen it, so the parent's reminder-ledger demotion must not apply.
  it('subagent-propagated memory renders full even after a prior parent injection', () => {
    writeMemory(
      fixture.storeDir,
      'prompt-scope.md',
      {
        name: 'prompt-scope-policy',
        description: 'once-mode prompt-scope memory',
        events: 'UserPromptSubmit',
        trigger_prompt: 'refactor',
        fire_mode: 'once',
        inject: 'full',
      },
      'SUBAGENT-FULL-BODY-ONCE'
    );

    // 1) Parent injection: marks the ledger injected (count → 1) for this session.
    const first = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(first.status, 0, `parent dispatch failed: ${first.stderr}`);
    assert.match(first.stdout, /SUBAGENT-FULL-BODY-ONCE/, 'parent injection should be full');

    // 2) Subagent spawn in the SAME session: must get the full body, not a reminder.
    const r = runDispatcher({
      event: 'PreToolUse',
      payload: subagentPayload('Task', 'please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, `subagent dispatch failed: ${r.stderr}`);
    const body = parseHookOutput(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(body, /SUBAGENT-FULL-BODY-ONCE/, 'subagent must receive the full memory body');
    assert.doesNotMatch(
      body,
      /fired earlier/,
      'subagent must NOT receive the one-line reminder (fresh context)'
    );
  });

  // PR #605 review B1 — the subagent→main-thread order. A subagent-propagated
  // injection must NOT bump the parent session ledger, so a LATER main-thread
  // match of the same memory still renders full (not an unresolvable reminder
  // for a body the main context never received).
  it('subagent-propagated injection does not demote a later main-thread match', () => {
    writeMemory(
      fixture.storeDir,
      'prompt-scope.md',
      {
        name: 'prompt-scope-policy',
        description: 'once-mode prompt-scope memory',
        events: 'UserPromptSubmit',
        trigger_prompt: 'refactor',
        fire_mode: 'once',
        inject: 'full',
      },
      'B1-LEDGER-BODY'
    );

    // 1) Subagent spawn first: full to the subagent, must NOT bump the parent ledger.
    const spawn = runDispatcher({
      event: 'PreToolUse',
      payload: subagentPayload('Task', 'please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(spawn.status, 0, `subagent dispatch failed: ${spawn.stderr}`);
    assert.match(
      parseHookOutput(spawn.stdout).hookSpecificOutput.additionalContext,
      /B1-LEDGER-BODY/,
      'subagent should get the full body'
    );

    // 2) Later main-thread UserPromptSubmit (same session) must still be FULL.
    const main = runDispatcher({
      event: 'UserPromptSubmit',
      payload: promptPayload('please refactor the auth module', fixture.cwd),
      home: fixture.home,
    });
    assert.equal(main.status, 0, `main dispatch failed: ${main.stderr}`);
    assert.match(main.stdout, /B1-LEDGER-BODY/, 'main thread must receive the full body');
    assert.doesNotMatch(
      main.stdout,
      /fired earlier/,
      'main thread must NOT be demoted to a reminder by a prior subagent-only injection'
    );
  });

  // ── 1.3 Non-blocking contract ─────────────────────────────────────────────

  it('Non-blocking contract holds on match', () => {
    writeMemory(
      fixture.storeDir,
      'push-policy.md',
      {
        name: 'push-policy',
        description: 'check before pushing',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:git\\s+push',
        inject: 'full',
      },
      'PRETOOL-PUSH-POLICY-BODY'
    );

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: bashPushPayload(fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, 'must exit 0 on match (non-blocking, additive)');
    assert.doesNotMatch(r.stdout, /"decision"/, 'stdout must not contain a decision field');
    assert.doesNotMatch(
      r.stdout,
      /"permissionDecision"/,
      'stdout must not contain a permissionDecision field'
    );
    assert.doesNotMatch(r.stdout, /"block"/, 'stdout must not emit a block decision');
    assert.doesNotMatch(r.stdout, /"deny"/, 'stdout must not emit a deny decision');
    assert.doesNotMatch(r.stdout, /"continue"\s*:\s*false/, 'stdout must not emit continue:false');
  });

  it('Dispatcher exits 0 even on internal error', () => {
    writeMemory(
      fixture.storeDir,
      'push-policy.md',
      {
        name: 'push-policy',
        description: 'check before pushing',
        events: 'PreToolUse',
        trigger_pretool: 'Bash:git\\s+push',
        inject: 'full',
      },
      'PRETOOL-PUSH-POLICY-BODY'
    );

    // Force an internal fault: poison the per-session ledger path by making the
    // ledger file a directory so every read/write throws. The dispatcher's
    // fail-open contract requires it to still exit 0 (and never block).
    const sessionDir = path.join(fixture.home, '.claude', 'synapsys', '.session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const ledgerFile = path.join(sessionDir, `${SESSION_ID}.json`);
    fs.mkdirSync(ledgerFile, { recursive: true });

    const r = runDispatcher({
      event: 'PreToolUse',
      payload: bashPushPayload(fixture.cwd),
      home: fixture.home,
    });
    assert.equal(r.status, 0, 'dispatcher must exit 0 even when an internal fault occurs');
    assert.doesNotMatch(r.stdout, /"decision"/, 'a fault must not produce a blocking decision');
  });
});

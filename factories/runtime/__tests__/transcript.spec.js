/**
 * Tests for factories/runtime/transcript.js — format sniffing, the
 * authoredOnly security rule (event_msg/user_message ONLY on codex;
 * tool_result excluded on claude), assistant/tool extraction, agent-context
 * detection, session listing, and injected-block stripping.
 *
 * Run: node --test factories/runtime/__tests__/transcript.spec.js
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sniffFormat,
  readUserMessages,
  readLastAssistantText,
  readToolEvents,
  detectAgentContext,
  listSessionsForCwd,
  stripInjected,
  flattenCwd,
} = require('../transcript');

const FIXTURES = path.join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'runtime');
const CLAUDE_TRANSCRIPT = path.join(FIXTURES, 'claude', 'transcript.jsonl');
const CODEX_ROLLOUT = path.join(FIXTURES, 'codex', 'rollout.jsonl');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-spec-'));
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function writeJsonl(name, lines) {
  const file = path.join(TMP, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`
  );
  return file;
}

describe('sniffFormat', () => {
  it('codex rollout (session_meta on line 1)', () => {
    assert.equal(sniffFormat(CODEX_ROLLOUT), 'codex');
  });

  it('claude transcript — even when line 1 is a bookkeeping record', () => {
    // Real claude transcripts open with last-prompt/mode/etc. lines; the sniff
    // scans for the first recognizable marker instead of trusting line 1.
    assert.equal(sniffFormat(CLAUDE_TRANSCRIPT), 'claude');
  });

  it('garbage / missing files are unknown', () => {
    const garbage = writeJsonl('garbage.jsonl', ['not json at all', '{"type":"mystery"}']);
    assert.equal(sniffFormat(garbage), 'unknown');
    assert.equal(sniffFormat(path.join(TMP, 'missing.jsonl')), 'unknown');
    assert.equal(sniffFormat(null), 'unknown');
  });
});

describe('readUserMessages — the heimdall unlock security surface', () => {
  it('codex authoredOnly: event_msg/user_message records ONLY', () => {
    const messages = readUserMessages(CODEX_ROLLOUT);
    assert.ok(messages.includes('Use the $probe:envprobe skill now.'));
    assert.ok(messages.includes('open sesame now please'));
    // The injected response_item user row and the function_call_output both
    // carry 'edit the vault' — neither may surface as user-authored text.
    assert.equal(
      messages.some((m) => m.includes('edit the vault')),
      false
    );
  });

  it('codex authoredOnly:false additionally reads response_item user rows', () => {
    const messages = readUserMessages(CODEX_ROLLOUT, { authoredOnly: false });
    assert.ok(messages.some((m) => m.includes('<environment_context>')));
    // function_call_output is tool output — excluded even here.
    assert.equal(
      messages.some((m) => m.includes('GREP-RC=0')),
      false
    );
  });

  it('claude: string + text blocks only; tool_result content is never user text', () => {
    const messages = readUserMessages(CLAUDE_TRANSCRIPT);
    assert.ok(messages.includes('get latest main'));
    assert.ok(messages.some((m) => m.includes('open sesame now please')));
    assert.equal(
      messages.some((m) => m.includes('edit the vault')),
      false
    );
  });

  it('unknown format returns empty with the unavailable marker', () => {
    const garbage = writeJsonl('garbage2.jsonl', ['{"type":"mystery"}']);
    const messages = readUserMessages(garbage);
    assert.deepEqual([...messages], []);
    assert.equal(messages.unavailable, true);
  });

  it('honors count', () => {
    assert.equal(readUserMessages(CLAUDE_TRANSCRIPT, { count: 1 }).length, 1);
  });
});

describe('readLastAssistantText', () => {
  it('claude: last assistant text blocks joined', () => {
    assert.equal(readLastAssistantText(CLAUDE_TRANSCRIPT), 'All checks passed. Ready for review.');
  });

  it('codex: last assistant response_item output_text', () => {
    assert.equal(
      readLastAssistantText(CODEX_ROLLOUT),
      'STEP1 done.\nAll four probe commands executed.'
    );
  });

  it('Stop payloads prefer last_assistant_message over the transcript', () => {
    const payload = { last_assistant_message: 'from payload', transcript_path: CODEX_ROLLOUT };
    assert.equal(readLastAssistantText(payload), 'from payload');
    assert.equal(
      readLastAssistantText({ transcript_path: CODEX_ROLLOUT }),
      'STEP1 done.\nAll four probe commands executed.'
    );
  });
});

describe('readToolEvents', () => {
  it('codex: function_call/function_call_output joined on call_id, shell names → Bash', () => {
    const events = readToolEvents(CODEX_ROLLOUT);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'Bash');
    assert.equal(events[0].rawName, 'exec_command');
    assert.match(events[0].input.cmd, /env \| grep/);
    assert.match(events[0].output, /GREP-RC=0/);
    assert.equal(readToolEvents(CODEX_ROLLOUT, { toolName: 'Bash' }).length, 1);
    assert.equal(readToolEvents(CODEX_ROLLOUT, { toolName: 'apply_patch' }).length, 0);
  });

  it('claude: tool_use/tool_result joined on id', () => {
    const events = readToolEvents(CLAUDE_TRANSCRIPT);
    assert.deepEqual(
      events.map((e) => e.name),
      ['Bash', 'Task']
    );
    assert.match(events[0].output, /Already up to date/);
    assert.equal(events[1].output, 'Task 1 complete.');
    assert.equal(readToolEvents(CLAUDE_TRANSCRIPT, { toolName: 'Task' }).length, 1);
  });
});

describe('detectAgentContext', () => {
  const aliases = ['developer-nodejs-tdd', 'work-workflow:developer-nodejs-tdd'];

  it('claude: completed dispatch (tool_result present) is NOT an active context', () => {
    assert.equal(detectAgentContext(CLAUDE_TRANSCRIPT, aliases), false);
  });

  it('claude: most recent dispatch without a tool_result IS active', () => {
    const lines = fs.readFileSync(CLAUDE_TRANSCRIPT, 'utf8').trim().split('\n');
    // Drop the Task tool_result line (uuid u3) — the dispatch becomes active.
    const active = writeJsonl(
      'active-task.jsonl',
      lines.filter((l) => !(l.includes('tool_result') && l.includes('toolu_task_1')))
    );
    assert.equal(detectAgentContext(active, aliases), true);
    assert.equal(detectAgentContext(active, ['pr-generator']), false);
  });

  it('claude: attributionAgent early-line marker is authoritative', () => {
    const file = writeJsonl('attribution.jsonl', [
      {
        type: 'user',
        attributionAgent: 'developer-nodejs-tdd',
        message: { role: 'user', content: 'go' },
      },
    ]);
    assert.equal(detectAgentContext(file, aliases), true);
    assert.equal(detectAgentContext(file, ['code-checker']), false);
  });

  it('codex: spawn_agent without its function_call_output is active', () => {
    const spawn = {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'spawn_agent',
        call_id: 'call_spawn_1',
        arguments: JSON.stringify({ agent_type: 'developer-nodejs-tdd', task_name: 'Task 1' }),
      },
    };
    const meta = { type: 'session_meta', payload: { cwd: '/tmp/x' } };
    const active = writeJsonl('codex-active.jsonl', [meta, spawn]);
    assert.equal(detectAgentContext(active, aliases), true);
    const done = writeJsonl('codex-done.jsonl', [
      meta,
      spawn,
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_spawn_1', output: 'ok' },
      },
    ]);
    assert.equal(detectAgentContext(done, aliases), false);
  });
});

describe('listSessionsForCwd', () => {
  it('codex: filters rollouts by line-1 session_meta.cwd within maxAgeDays', () => {
    const root = path.join(TMP, 'codex-sessions');
    const now = new Date();
    const day = path.join(
      root,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    );
    fs.mkdirSync(day, { recursive: true });
    fs.mkdirSync(path.join(root, '2020', '01', '01'), { recursive: true });
    const meta = (cwd) => `${JSON.stringify({ type: 'session_meta', payload: { cwd } })}\n`;
    fs.writeFileSync(path.join(day, 'rollout-2026-07-07T10-00-00-aaa.jsonl'), meta('/work/tree'));
    fs.writeFileSync(path.join(day, 'rollout-2026-07-07T11-00-00-bbb.jsonl'), meta('/work/tree'));
    fs.writeFileSync(path.join(day, 'rollout-2026-07-07T12-00-00-ccc.jsonl'), meta('/other'));
    fs.writeFileSync(
      path.join(root, '2020', '01', '01', 'rollout-2020-01-01T00-00-00-old.jsonl'),
      meta('/work/tree')
    );
    const found = listSessionsForCwd('/work/tree', { root, runtime: 'codex' });
    assert.deepEqual(
      found.map((f) => path.basename(f)),
      ['rollout-2026-07-07T11-00-00-bbb.jsonl', 'rollout-2026-07-07T10-00-00-aaa.jsonl']
    );
  });

  it('claude: lists <root>/<flattened-cwd>/*.jsonl', () => {
    const root = path.join(TMP, 'claude-projects');
    const dir = path.join(root, flattenCwd('/work/tree'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session-1.jsonl'), '{"type":"user"}\n');
    const found = listSessionsForCwd('/work/tree', { root, runtime: 'claude' });
    assert.deepEqual(
      found.map((f) => path.basename(f)),
      ['session-1.jsonl']
    );
    assert.deepEqual(listSessionsForCwd('/nope', { root, runtime: 'claude' }), []);
  });

  it('flattenCwd matches the claude project-dir encoding', () => {
    assert.equal(flattenCwd('/tmp/a_b.c'), '-tmp-a-b-c');
  });
});

describe('stripInjected', () => {
  it('claude: system tags removed', () => {
    assert.equal(
      stripInjected('<system-reminder>noise</system-reminder> open sesame now please', 'claude'),
      'open sesame now please'
    );
  });

  it('codex: environment/skill/INSTRUCTIONS blocks removed', () => {
    const text =
      '<environment_context><cwd>/x</cwd></environment_context>\n<skill>body</skill>\nreal text';
    assert.equal(stripInjected(text, 'codex'), 'real text');
  });
});

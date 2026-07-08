'use strict';

/**
 * WP-05: replay over codex session rollouts.
 *
 * extractEvents grows shape-keyed codex branches: `event_msg`/`user_message`
 * records ONLY become UserPromptSubmit events (response_item user-role rows
 * carry injected AGENTS.md/skill/hook context and must never count as user
 * prompts — the same authoredOnly rule as the vendored reader), and
 * `response_item` function_call records become PreToolUse events with codex
 * shell-like names normalized to 'Bash' so `Bash:` specs replay.
 *
 * walkTranscripts grows the codex leg: `<codexBase>/YYYY/MM/DD/rollout-*.jsonl`
 * filtered by line-1 session_meta.cwd. Claude walks with an explicit baseDir
 * or --project stay byte-identical (no codex leg unless codexBase is passed).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const events = require(path.resolve(__dirname, '..', 'replay-events'));
const matcher = require(path.resolve(__dirname, '..', 'matcher'));

const { extractEvents, walkTranscripts, replayEvent } = events;

// ---------------------------------------------------------------------------
// extractEvents — codex rollout record shapes (probe-verified)
// ---------------------------------------------------------------------------

test('event_msg user_message becomes a UserPromptSubmit event', () => {
  const out = extractEvents({
    type: 'event_msg',
    payload: { type: 'user_message', message: 'open sesame now please' },
  });
  assert.deepEqual(out, [{ event: 'UserPromptSubmit', prompt: 'open sesame now please' }]);
});

test('event_msg non-user payloads are ignored', () => {
  for (const payload of [
    { type: 'task_started', turn_id: 't1' },
    { type: 'token_count', total: 5 },
  ]) {
    assert.deepEqual(extractEvents({ type: 'event_msg', payload }), []);
  }
});

test('response_item user-role messages are NOT user prompts (injected context)', () => {
  const out = extractEvents({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>x</environment_context>hi' }],
    },
  });
  assert.deepEqual(out, []);
});

test('injected wrappers are stripped from event_msg user text before replay', () => {
  const out = extractEvents({
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: '<environment_context>\n<cwd>/x</cwd>\n</environment_context>\nreal prompt',
    },
  });
  assert.deepEqual(out, [{ event: 'UserPromptSubmit', prompt: 'real prompt' }]);
});

test('function_call shell-like names normalize to Bash PreToolUse events', () => {
  const out = extractEvents({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'c1',
      arguments: '{"cmd":"git push origin main"}',
    },
  });
  assert.deepEqual(out, [
    { event: 'PreToolUse', tool: 'Bash', tool_input: { cmd: 'git push origin main' } },
  ]);
});

test('function_call apply_patch keeps its native name for the alias hop', () => {
  const patch = '*** Begin Patch\n*** Update File: .claude/settings.json\n+x\n*** End Patch\n';
  const out = extractEvents({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'apply_patch',
      call_id: 'c2',
      arguments: JSON.stringify({ command: patch }),
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, 'apply_patch');

  // and the replayed event fires an Edit:-spec memory through the alias hop.
  const memory = {
    name: 'edit-dotclaude',
    events: ['PreToolUse'],
    triggerPrompt: '',
    triggerPretool: ['Edit:\\.claude/'],
    triggerSession: false,
  };
  const tuples = replayEvent([memory], out[0]);
  assert.equal(tuples[0].fired, true);
});

test('function_call_output records are ignored', () => {
  const out = extractEvents({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' },
  });
  assert.deepEqual(out, []);
});

test('claude transcript rows keep extracting exactly as before', () => {
  const user = extractEvents({ type: 'user', message: { content: 'hello there' } });
  assert.deepEqual(user, [{ event: 'UserPromptSubmit', prompt: 'hello there' }]);
  const assistant = extractEvents({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
  });
  assert.deepEqual(assistant, [
    { event: 'PreToolUse', tool: 'Bash', tool_input: { command: 'ls' } },
  ]);
});

// ---------------------------------------------------------------------------
// walkTranscripts — the codex sessions walker
// ---------------------------------------------------------------------------

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())];
}

function makeCodexTree(cwd) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-codex-'));
  const [y, m, d] = today();
  const dayDir = path.join(base, y, m, d);
  fs.mkdirSync(dayDir, { recursive: true });
  const write = (name, sessionCwd) => {
    const file = path.join(dayDir, name);
    const lines = [
      { type: 'session_meta', payload: { id: name, cwd: sessionCwd } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'hi from rollout' } },
    ];
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return file;
  };
  const matching = write('rollout-2026-07-07T08-00-00-aaa.jsonl', cwd);
  write('rollout-2026-07-07T09-00-00-bbb.jsonl', '/somewhere/else');
  return { base, matching };
}

test('walkTranscripts returns rollouts whose session_meta.cwd matches cwd', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-cwd-'));
  const { base, matching } = makeCodexTree(cwd);
  const emptyClaudeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-claude-'));
  const files = walkTranscripts({
    since: '7d',
    baseDir: emptyClaudeBase,
    codexBase: base,
    cwd,
    allProjects: true,
  });
  assert.deepEqual(files, [matching], 'only the cwd-matching rollout is picked up');
});

test('claude-only walks (explicit baseDir, no codexBase) stay codex-free', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-cwd-'));
  makeCodexTree(cwd);
  const claudeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-claude-'));
  const projDir = path.join(claudeBase, 'some-project');
  fs.mkdirSync(projDir);
  const claudeFile = path.join(projDir, 'session.jsonl');
  fs.writeFileSync(claudeFile, `${JSON.stringify({ type: 'user', message: { content: 'x' } })}\n`);
  const files = walkTranscripts({ since: '7d', baseDir: claudeBase, cwd, allProjects: true });
  assert.deepEqual(files, [claudeFile]);
});

test('walkTranscripts codex leg is skipped without a cwd to filter by', () => {
  const { base } = makeCodexTree('/any/cwd');
  const emptyClaudeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-claude-'));
  const files = walkTranscripts({
    since: '7d',
    baseDir: emptyClaudeBase,
    codexBase: base,
    allProjects: true,
  });
  assert.deepEqual(files, []);
});

test('a walked rollout replays end-to-end against a prompt memory', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-cwd-'));
  const { base } = makeCodexTree(cwd);
  const emptyClaudeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-claude-'));
  const files = walkTranscripts({
    since: '7d',
    baseDir: emptyClaudeBase,
    codexBase: base,
    cwd,
  });
  assert.equal(files.length, 1);
  const extracted = [];
  for (const line of events.iterLines(files[0])) extracted.push(...extractEvents(line));
  assert.deepEqual(extracted, [{ event: 'UserPromptSubmit', prompt: 'hi from rollout' }]);
  const memory = {
    name: 'rollout-prompt',
    events: ['UserPromptSubmit'],
    triggerPrompt: 'from rollout',
    triggerPretool: [],
    triggerSession: false,
  };
  const result = matcher.matchPrompt(memory, extracted[0].prompt);
  assert.equal(result.fired, true);
});

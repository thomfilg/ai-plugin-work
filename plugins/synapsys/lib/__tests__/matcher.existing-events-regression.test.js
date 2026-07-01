'use strict';

// GH-473 Task 3 (3.2): regression guard (C-4). Adding the PostToolUse route to
// EVENT_MATCHERS must NOT change the behavior or reason codes of the four
// existing event routes (SessionStart, UserPromptSubmit, PreToolUse, Stop).
// These assertions are written to fail only if a fire result or reason code
// drifts for a representative positive + negative fixture per event.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { selectForEvent } = require(path.resolve(__dirname, '..', 'matcher'));

function makeMemory(overrides) {
  return Object.assign(
    {
      name: 'm',
      events: [],
      triggerPrompt: '',
      triggerPretool: [],
      triggerSession: false,
      disabled: false,
      expired: false,
    },
    overrides
  );
}

// Table-driven fixtures: each row is { event, memory, payload, fires }.
// Positive rows expect the memory in selectForEvent's result; negative rows
// expect it absent. selectForEvent only exposes `.fired`, so this locks the
// observable byte-for-byte routing parity for each existing event.
const FIXTURES = [
  // SessionStart — positive: triggerSession true fires; negative: false does not.
  {
    name: 'SessionStart positive (triggerSession true)',
    event: 'SessionStart',
    memory: makeMemory({ name: 'sess', events: ['SessionStart'], triggerSession: true }),
    payload: {},
    fires: true,
  },
  {
    name: 'SessionStart negative (triggerSession false -> no-session-trigger)',
    event: 'SessionStart',
    memory: makeMemory({ name: 'sess', events: ['SessionStart'], triggerSession: false }),
    payload: {},
    fires: false,
  },
  // UserPromptSubmit — positive: prompt matches regex; negative: no match.
  {
    name: 'UserPromptSubmit positive (prompt matches)',
    event: 'UserPromptSubmit',
    memory: makeMemory({ name: 'prompt', events: ['UserPromptSubmit'], triggerPrompt: '\\bdeploy\\b' }),
    payload: { prompt: 'please deploy now' },
    fires: true,
  },
  {
    name: 'UserPromptSubmit negative (no prompt match)',
    event: 'UserPromptSubmit',
    memory: makeMemory({ name: 'prompt', events: ['UserPromptSubmit'], triggerPrompt: '\\bdeploy\\b' }),
    payload: { prompt: 'just chatting' },
    fires: false,
  },
  // PreToolUse — positive: tool/path prefix matches; negative: tool mismatch.
  {
    name: 'PreToolUse positive (tool prefix matches)',
    event: 'PreToolUse',
    memory: makeMemory({ name: 'pre', events: ['PreToolUse'], triggerPretool: ['Bash:rm '] }),
    payload: { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } },
    fires: true,
  },
  {
    name: 'PreToolUse negative (tool mismatch -> no-pretool-match)',
    event: 'PreToolUse',
    memory: makeMemory({ name: 'pre', events: ['PreToolUse'], triggerPretool: ['Bash:rm '] }),
    payload: { tool_name: 'Edit', tool_input: { file_path: '/tmp/x' } },
    fires: false,
  },
  // Stop — positive: Stop in events fires; negative: Stop not listed.
  {
    name: 'Stop positive (Stop in events)',
    event: 'Stop',
    memory: makeMemory({ name: 'stop', events: ['Stop'] }),
    payload: {},
    fires: true,
  },
  {
    name: 'Stop negative (Stop not in events)',
    event: 'Stop',
    memory: makeMemory({ name: 'stop', events: ['UserPromptSubmit'] }),
    payload: {},
    fires: false,
  },
];

for (const fx of FIXTURES) {
  test(`existing-event regression: ${fx.name}`, () => {
    const picked = selectForEvent([fx.memory], fx.event, fx.payload).map((m) => m.name);
    if (fx.fires) {
      assert.deepEqual(picked, [fx.memory.name], `expected ${fx.event} memory to fire`);
    } else {
      assert.deepEqual(picked, [], `expected ${fx.event} memory NOT to fire`);
    }
  });
}

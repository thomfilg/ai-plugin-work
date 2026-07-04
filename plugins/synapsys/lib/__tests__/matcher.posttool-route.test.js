'use strict';

// GH-473 Task 3 (3.1): matcher.js must require + re-bind matchPostTool from the
// matcher-posttool.js sub-module (injecting the shared helpers exactly like
// matchStop is bound), register a `PostToolUse` route in EVENT_MATCHERS, and
// export matchPostTool. These tests pin that wiring: selectForEvent routes the
// PostToolUse event through matchPostTool, and matchPostTool is exported and
// callable. Distinct from matchPreToolResult (P0-3, C-2).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const matcherModule = require(path.resolve(__dirname, '..', 'matcher'));
const { selectForEvent, matchPostTool } = matcherModule;

function makeMemory(overrides) {
  return Object.assign(
    {
      name: 'm',
      events: ['PostToolUse'],
      triggerPrompt: '',
      triggerPretool: [],
      triggerSession: false,
      triggerPosttoolContent: [],
      triggerPosttoolContentNot: [],
      triggerPosttoolExit: null,
    },
    overrides
  );
}

// A failing-test payload: Bash pnpm test that exited nonzero.
const failingTestPayload = {
  tool_name: 'Bash',
  tool_input: { command: 'pnpm test' },
  tool_response: { stdout: '1 failing', exit_code: 1 },
};

// ---------- 3.1.1 export ----------

test('matchPostTool is exported from matcher.js and is callable', () => {
  assert.equal(typeof matchPostTool, 'function');
});

test('require("../matcher").matchPostTool is exported', () => {
  assert.equal(typeof require(path.resolve(__dirname, '..', 'matcher')).matchPostTool, 'function');
});

// ---------- 3.1.1 selectForEvent routes PostToolUse through matchPostTool ----------

test('selectForEvent("PostToolUse", ...) fires for a trigger_pretool + nonzero-exit memory', () => {
  const memory = makeMemory({
    name: 'failing-test-protocol',
    triggerPretool: ['Bash:pnpm test'],
    triggerPosttoolExit: 'nonzero',
  });
  const picked = selectForEvent([memory], 'PostToolUse', failingTestPayload).map((m) => m.name);
  assert.deepEqual(picked, ['failing-test-protocol']);
});

test('selectForEvent("PostToolUse", ...) does NOT fire on a successful (exit 0) run', () => {
  const memory = makeMemory({
    name: 'failing-test-protocol',
    triggerPretool: ['Bash:pnpm test'],
    triggerPosttoolExit: 'nonzero',
  });
  const passingPayload = {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'all green', exit_code: 0 },
  };
  const picked = selectForEvent([memory], 'PostToolUse', passingPayload);
  assert.deepEqual(picked, []);
});

test('selectForEvent("PostToolUse", ...) picks only PostToolUse-event memories', () => {
  const memories = [
    makeMemory({ name: 'post-mem', events: ['PostToolUse'], triggerPretool: ['Bash:pnpm test'], triggerPosttoolExit: 'nonzero' }),
    makeMemory({ name: 'pre-mem', events: ['PreToolUse'] }),
  ];
  const picked = selectForEvent(memories, 'PostToolUse', failingTestPayload).map((m) => m.name);
  assert.deepEqual(picked, ['post-mem']);
});

// ---------- 3.1.3 matchPostTool re-bind injects helpers (callable directly) ----------

test('matchPostTool (re-bound, 2-arg) fires when injected helpers are wired correctly', () => {
  const memory = makeMemory({
    name: 'failing-test-protocol',
    triggerPretool: ['Bash:pnpm test'],
    triggerPosttoolExit: 'nonzero',
  });
  const result = matchPostTool(memory, failingTestPayload);
  assert.equal(result.fired, true);
  assert.equal(result.matched.posttool_exit, 'nonzero');
});

test('matchPostTool (re-bound) returns no-pretool-match when the tool target does not match', () => {
  const memory = makeMemory({
    name: 'failing-test-protocol',
    triggerPretool: ['Bash:pnpm test'],
    triggerPosttoolExit: 'nonzero',
  });
  const editPayload = {
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/x' },
    tool_response: { exit_code: 1 },
  };
  const result = matchPostTool(memory, editPayload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-pretool-match');
});

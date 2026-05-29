'use strict';

// GH-440 bot review: the writer's VALID_EVENTS accepts "Stop" and the
// classifier matrix advertises it as a valid choice, but the runtime hook
// dispatcher + matcher had no path for it. These tests pin the new behavior:
// matchStop fires for any memory listing Stop in events, and selectForEvent
// routes the Stop event through it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { matchStop, selectForEvent } = require(path.resolve(__dirname, '..', 'matcher'));

function makeMemory(overrides) {
  return Object.assign(
    {
      name: 'm',
      events: ['Stop'],
      triggerPrompt: '',
      triggerPretool: [],
      triggerSession: false,
    },
    overrides
  );
}

test('matchStop returns true when memory has Stop in events', () => {
  assert.equal(matchStop(makeMemory({ events: ['Stop'] })), true);
});

test('matchStop returns true even when other events are also listed', () => {
  assert.equal(matchStop(makeMemory({ events: ['PreToolUse', 'Stop'] })), true);
});

test('matchStop returns false when memory has no Stop event', () => {
  assert.equal(matchStop(makeMemory({ events: ['UserPromptSubmit'] })), false);
});

test('selectForEvent("Stop", ...) picks only Stop-event memories', () => {
  const memories = [
    makeMemory({ name: 'stop-mem', events: ['Stop'] }),
    makeMemory({ name: 'prompt-mem', events: ['UserPromptSubmit'] }),
    makeMemory({ name: 'multi-mem', events: ['PreToolUse', 'Stop'] }),
  ];
  const picked = selectForEvent(memories, 'Stop', {}).map((m) => m.name);
  assert.deepEqual(picked.sort(), ['multi-mem', 'stop-mem']);
});

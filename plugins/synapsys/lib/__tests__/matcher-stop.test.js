'use strict';

// GH-440 bot review: the writer's VALID_EVENTS accepts "Stop" and the
// classifier matrix advertises it as a valid choice, but the runtime hook
// dispatcher + matcher had no path for it. These tests pin the new behavior:
// matchStop fires for any memory listing Stop in events, and selectForEvent
// routes the Stop event through it.
//
// GH-521 Task 2 extends matchStop with `trigger_stop_response` regex
// evaluation: when the memory carries the field, matchStop must consult
// payload.response (and fallbacks) and only fire on a regex hit, returning
// `'no-stop-response-match'` otherwise.
//
// INTENTIONAL BEHAVIOR CHANGE: a Stop memory WITHOUT trigger_stop_response no
// longer fires unconditionally. Stop stdout never reaches the model, so the
// old fail-open fire only churned the ledger/telemetry every turn end. Such
// memories now return { fired: false, reason: 'no-stop-response-configured' }.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const matcherModule = require(path.resolve(__dirname, '..', 'matcher'));
const { matchStop, selectForEvent } = matcherModule;

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

// ---------- Event-gate regression guards ----------------------------------

test('matchStop without trigger_stop_response returns no-stop-response-configured', () => {
  const result = matchStop(makeMemory({ events: ['Stop'] }));
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-stop-response-configured');
});

test('matchStop without trigger_stop_response does not fire even when other events are also listed', () => {
  const result = matchStop(makeMemory({ events: ['PreToolUse', 'Stop'] }));
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-stop-response-configured');
});

test('matchStop returns { fired: false, reason: "events-exclude" } when memory has no Stop event', () => {
  const result = matchStop(makeMemory({ events: ['UserPromptSubmit'] }));
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'events-exclude');
});

test('selectForEvent("Stop", ...) picks only Stop-event memories with a matching stop response', () => {
  const memories = [
    makeMemory({ name: 'stop-mem', events: ['Stop'], triggerStopResponse: 'done' }),
    makeMemory({ name: 'prompt-mem', events: ['UserPromptSubmit'], triggerStopResponse: 'done' }),
    makeMemory({ name: 'multi-mem', events: ['PreToolUse', 'Stop'], triggerStopResponse: 'done' }),
    // No trigger_stop_response → never fires on Stop (no-stop-response-configured).
    makeMemory({ name: 'bare-stop-mem', events: ['Stop'] }),
  ];
  const picked = selectForEvent(memories, 'Stop', { response: 'all done' }).map((m) => m.name);
  assert.deepEqual(picked.sort(), ['multi-mem', 'stop-mem']);
});

// ---------- Task 2 new scenarios (a)–(g) ---------------------------------

// (a) field-present + matching payload.response -> { fired: true }
test('matchStop (a): triggerStopResponse present and payload.response matches -> fires', () => {
  const memory = makeMemory({
    name: 'flaky-test-fix-protocol',
    triggerStopResponse: '\\b(flaky|bump\\s+timeout)\\b',
  });
  const result = matchStop(memory, { response: 'let me bump timeout to fix this flaky test' });
  assert.equal(result.fired, true);
});

// (b) field-present + non-matching response -> { fired: false, reason: 'no-stop-response-match' }
test('matchStop (b): triggerStopResponse present but response does not match -> no-stop-response-match', () => {
  const memory = makeMemory({
    name: 'flaky-test-fix-protocol',
    triggerStopResponse: '\\b(flaky|bump\\s+timeout)\\b',
  });
  const result = matchStop(memory, { response: 'added a new component' });
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-stop-response-match');
});

// (c) field-absent + any payload -> never fires (no-stop-response-configured).
// Formerly fired unconditionally (fail-open every turn end); intentionally
// changed because Stop stdout never reaches the model.
test('matchStop (c): no triggerStopResponse field -> no-stop-response-configured', () => {
  const memory = makeMemory({ name: 'classic-stop' });
  const result = matchStop(memory, { response: 'whatever' });
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-stop-response-configured');
});

// (d) field-present + response empty but tool_inputs/tool_results contain the pattern
test('matchStop (d): pattern only in tool_inputs/tool_results is NOT matched (surface exclusion)', () => {
  const memory = makeMemory({
    name: 'flaky-test-fix-protocol',
    triggerStopResponse: '\\bflaky\\b',
  });
  const payload = {
    response: '',
    tool_inputs: [{ command: 'pnpm test --grep flaky' }],
    tool_results: [{ output: 'a flaky test was rerun' }],
  };
  const result = matchStop(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-stop-response-match');
});

// (e) invalid regex -> non-match + stderr contains memory name + pattern but NOT matched substring
test('matchStop (e): invalid regex -> no-stop-response-match and stderr scrubs matched substring', () => {
  const memory = makeMemory({
    name: 'broken-pattern-memory',
    triggerStopResponse: '[unclosed',
  });

  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  let result;
  try {
    result = matchStop(memory, { response: 'this response should not appear in stderr' });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-stop-response-match');
  const stderrText = captured.join('');
  assert.ok(
    stderrText.includes('broken-pattern-memory'),
    `stderr should mention memory name, got: ${stderrText}`
  );
  assert.ok(stderrText.includes('[unclosed'), `stderr should mention pattern, got: ${stderrText}`);
  assert.ok(
    !stderrText.includes('this response should not appear in stderr'),
    `stderr must NOT contain matched/response substring, got: ${stderrText}`
  );
});

// (f) _extractStopResponse fallback chain
test('matchStop (f): _extractStopResponse fallback chain (response > assistant_response > transcript > "")', () => {
  const extractStopResponse = matcherModule._extractStopResponse;
  assert.equal(
    typeof extractStopResponse,
    'function',
    '_extractStopResponse must be exposed for tests'
  );

  // payload.response wins when present
  assert.equal(
    extractStopResponse({ response: 'A', assistant_response: 'B', transcript: 'C' }),
    'A'
  );
  // assistant_response is read when response is absent
  assert.equal(extractStopResponse({ assistant_response: 'B', transcript: 'C' }), 'B');
  // transcript is read when both response and assistant_response are absent
  assert.equal(extractStopResponse({ transcript: 'C' }), 'C');
  // when none are strings, returns ''
  assert.equal(extractStopResponse({}), '');
  assert.equal(extractStopResponse({ response: 42, assistant_response: null, transcript: [] }), '');
  assert.equal(extractStopResponse(null), '');
  assert.equal(extractStopResponse(undefined), '');
});

// (g) selectForEvent('Stop', ...) forwards payload to matchStop
test('matchStop (g): selectForEvent forwards payload to matchStop for Stop event', () => {
  const memories = [
    makeMemory({
      name: 'needs-flaky',
      triggerStopResponse: '\\bflaky\\b',
    }),
    makeMemory({
      name: 'needs-bump',
      triggerStopResponse: '\\bbump\\s+timeout\\b',
    }),
  ];

  // payload.response contains 'flaky' but not 'bump timeout'
  const pickedFlaky = selectForEvent(memories, 'Stop', {
    response: 'this test is flaky',
  }).map((m) => m.name);
  assert.deepEqual(pickedFlaky, ['needs-flaky']);

  // payload.response matches neither
  const pickedNone = selectForEvent(memories, 'Stop', {
    response: 'nothing relevant',
  }).map((m) => m.name);
  assert.deepEqual(pickedNone, []);

  // payload.response matches both
  const pickedBoth = selectForEvent(memories, 'Stop', {
    response: 'flaky — let me bump timeout',
  })
    .map((m) => m.name)
    .sort();
  assert.deepEqual(pickedBoth, ['needs-bump', 'needs-flaky']);
});

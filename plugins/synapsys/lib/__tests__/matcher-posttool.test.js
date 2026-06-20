'use strict';

// GH-473 Task 2 — unit tests for the new matcher-posttool.js sub-module.
//
// matchPostTool inspects the tool OUTPUT (tool_response, stringified) plus the
// process exit code. It is DISTINCT from matchPreToolResult (which reads
// tool_input). This file requires the sub-module directly and injects the same
// shared helpers matcher.js will inject in Task 3, mirroring how
// matcher-stop.test.js exercises matchStop.
//
// Locked evaluation order (GH-510, C-1):
//   1. events/disabled/expired gate
//   2. positive trigger_pretool prefix  (`no-pretool-match` on miss)
//   3. content/exit stage:
//        positive trigger_posttool_content (`no-content-match` on miss)
//        then    trigger_posttool_content_not (`negative-excludes` priority)
//        then    trigger_posttool_exit       (`no-exit-match` on miss/absent)
//   4. exclude_* suppression (`exclude-matched`)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const posttool = require(path.resolve(__dirname, '..', 'matcher-posttool'));
const { matchPostTool, _extractPostToolResponse, _evaluatePostToolExit } = posttool;

// ---- shared helper injection (mirrors matcher.js Task 3 re-bind) ----------

function gateMemory(memory, event) {
  if (!memory.events.includes(event)) return 'events-exclude';
  if (memory.disabled === true) return 'disabled';
  if (memory.expired === true) return 'expired';
  return null;
}

function makeMatched(fields) {
  const matched = {};
  for (const k of Object.keys(fields)) {
    if (fields[k] !== undefined && fields[k] !== null) matched[k] = fields[k];
  }
  return matched;
}

function safeRegex(src, flags) {
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

function parsePretoolSpec(spec) {
  const colon = spec.indexOf(':');
  if (colon === -1) return { tool: spec, pat: '' };
  return { tool: spec.slice(0, colon).trim(), pat: spec.slice(colon + 1).trim() };
}

function pretoolSpecMatches(spec, toolName, argBlob) {
  const { tool, pat } = parsePretoolSpec(spec);
  if (tool && tool !== '*' && tool !== toolName) return false;
  if (!pat) return true;
  const re = safeRegex(pat);
  return re ? re.test(argBlob) : false;
}

function findContentMatch(memory, contentString) {
  const patterns = memory.triggerPosttoolContent;
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  let hit = null;
  for (const pat of patterns) {
    let re;
    try {
      re = new RegExp(pat, 'im');
    } catch (err) {
      process.stderr.write(`[synapsys] memory ${memory.name}: invalid regex "${pat}": ${err.message}\n`);
      continue;
    }
    const m = re.exec(contentString);
    if (m && hit === null) hit = { pattern: pat, substring: m[0] };
  }
  return hit;
}

function hasNegativeContentPatterns(memory) {
  return (
    Array.isArray(memory.triggerPosttoolContentNot) && memory.triggerPosttoolContentNot.length > 0
  );
}

function evaluatePretoolContentNot(memory, contentString) {
  const patterns = memory.triggerPosttoolContentNot;
  if (!Array.isArray(patterns) || patterns.length === 0) return { excluded: false, pattern: null };
  for (const pat of patterns) {
    let re;
    try {
      re = new RegExp(pat, 'im');
    } catch {
      continue;
    }
    if (re.test(contentString)) return { excluded: true, pattern: pat };
  }
  return { excluded: false, pattern: null };
}

// Mock of matcher.js's bound evaluateExcludePretool (stage-4 veto): matches
// memory.excludePretool specs against tool_name + argBlob, mirroring the real
// matcher-excludes implementation's return shape.
function evaluateExcludePretool(memory, toolName, argBlob) {
  const specs = memory.excludePretool;
  if (!Array.isArray(specs) || specs.length === 0) return { excluded: false, pattern: null };
  for (const spec of specs) {
    if (pretoolSpecMatches(spec, toolName, argBlob)) return { excluded: true, pattern: spec };
  }
  return { excluded: false, pattern: null };
}

const HELPERS = {
  gateMemory,
  safeRegex,
  makeMatched,
  parsePretoolSpec,
  pretoolSpecMatches,
  findContentMatch,
  hasNegativeContentPatterns,
  evaluatePretoolContentNot,
  evaluateExcludePretool,
};

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
      excludePretool: [],
    },
    overrides
  );
}

function run(memory, payload) {
  return matchPostTool(memory, payload, HELPERS);
}

// ===================== 2.1 pretool prefix gate + extraction ================

test('matchPostTool fires on a matching trigger_pretool prefix (Bash:pnpm test)', () => {
  const memory = makeMemory({ triggerPretool: ['Bash:pnpm test'] });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'all good', stderr: '', exit_code: 0 },
  };
  assert.equal(run(memory, payload).fired, true);
});

test('matchPostTool returns no-pretool-match when tool does not match the target', () => {
  const memory = makeMemory({ triggerPretool: ['Bash:pnpm test'] });
  const payload = {
    tool_name: 'Edit',
    tool_input: { file_path: '/a.js', new_string: 'x' },
    tool_response: 'edited',
  };
  const result = run(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-pretool-match');
});

test('empty trigger_pretool is output-inspection mode: a content-only memory fires on any tool', () => {
  // No trigger_pretool target — lint (R11) treats trigger_posttool_content as
  // standalone targeting, so the matcher must NOT reject with no-pretool-match.
  const memory = makeMemory({ triggerPosttoolContent: ['ENOTFOUND'] });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    tool_response: { stdout: 'getaddrinfo ENOTFOUND registry.npmjs.org', stderr: '' },
  };
  const result = run(memory, payload);
  assert.equal(result.fired, true);
  assert.equal(result.matched.posttool_content_substring, 'ENOTFOUND');
});

test('empty trigger_pretool: an exit-only memory fires on matching exit code', () => {
  const memory = makeMemory({ triggerPosttoolExit: 'nonzero' });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: '', stderr: 'fail', exit_code: 1 },
  };
  const result = run(memory, payload);
  assert.equal(result.fired, true);
  assert.equal(result.matched.posttool_exit, 'nonzero');
});

test('stage-4 exclude_pretool suppresses an otherwise-firing PostToolUse memory (exclude-matched)', () => {
  // Positive trigger + exit gate would fire, but exclude_pretool vetoes it —
  // mirrors matchPreTool's stage-4 (locked order GH-510). Without the veto this
  // memory would inject on a PostToolUse where PreToolUse would exclude it.
  const memory = makeMemory({
    triggerPretool: ['Bash:'],
    triggerPosttoolExit: 'nonzero',
    excludePretool: ['Bash:pnpm test'],
  });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: '', stderr: 'fail', exit_code: 1 },
  };
  const result = run(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'exclude-matched');
  assert.equal(result.matched.excluded_pattern, 'Bash:pnpm test');
});

test('exclude_pretool that does NOT match leaves the memory firing', () => {
  const memory = makeMemory({
    triggerPretool: ['Bash:'],
    triggerPosttoolExit: 'nonzero',
    excludePretool: ['Bash:gh pr create'],
  });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: '', stderr: 'fail', exit_code: 1 },
  };
  assert.equal(run(memory, payload).fired, true);
});

test('_extractPostToolResponse returns string responses directly', () => {
  assert.equal(typeof _extractPostToolResponse, 'function');
  assert.equal(_extractPostToolResponse({ tool_response: 'plain string output' }), 'plain string output');
});

test('_extractPostToolResponse JSON-stringifies object responses so stdout/stderr are searchable', () => {
  const out = _extractPostToolResponse({
    tool_response: { stdout: 'getaddrinfo ENOTFOUND registry', stderr: 'boom' },
  });
  assert.ok(out.includes('ENOTFOUND'));
  assert.ok(out.includes('boom'));
});

// ===================== 2.2 content + negative-content gates ================

test('positive trigger_posttool_content fires with matched substring ENOTFOUND', () => {
  const memory = makeMemory({
    triggerPretool: ['Bash:'],
    triggerPosttoolContent: ['ENOTFOUND'],
  });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    tool_response: { stdout: 'getaddrinfo ENOTFOUND registry.npmjs.org', stderr: '' },
  };
  const result = run(memory, payload);
  assert.equal(result.fired, true);
  assert.equal(result.matched.posttool_content_substring, 'ENOTFOUND');
});

test('trigger_posttool_content_not suppresses with reason negative-excludes', () => {
  const memory = makeMemory({
    triggerPretool: ['Bash:'],
    triggerPosttoolContent: ['error'],
    triggerPosttoolContentNot: ['warning: deprecated'],
  });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'build' },
    tool_response: { stdout: 'error: build failed\nwarning: deprecated api', stderr: '' },
  };
  const result = run(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'negative-excludes');
  assert.equal(result.matched.negative_pattern, 'warning: deprecated');
});

test('content gate misses return no-content-match', () => {
  const memory = makeMemory({
    triggerPretool: ['Bash:'],
    triggerPosttoolContent: ['ENOTFOUND'],
  });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { stdout: 'hi', stderr: '' },
  };
  const result = run(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-content-match');
});

test('invalid content regex is skipped without throwing (fail-open C-5)', () => {
  const memory = makeMemory({
    triggerPretool: ['Bash:'],
    triggerPosttoolContent: ['[unclosed', 'ENOTFOUND'],
  });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    tool_response: { stdout: 'getaddrinfo ENOTFOUND registry', stderr: '' },
  };
  let result;
  assert.doesNotThrow(() => {
    result = run(memory, payload);
  });
  assert.equal(result.fired, true);
});

// ===================== 2.3 exit-code gate ==================================

test('_evaluatePostToolExit nonzero matches exit_code 1, rejects 0', () => {
  assert.equal(typeof _evaluatePostToolExit, 'function');
  const okMemory = makeMemory({ triggerPosttoolExit: 'nonzero' });
  assert.equal(
    _evaluatePostToolExit(okMemory, { tool_response: { exit_code: 1 } }).matched,
    true
  );
  const rej = _evaluatePostToolExit(okMemory, { tool_response: { exit_code: 0 } });
  assert.equal(rej.matched, false);
});

test('_evaluatePostToolExit zero matches exit_code 0, specific code matches', () => {
  assert.equal(
    _evaluatePostToolExit(makeMemory({ triggerPosttoolExit: 'zero' }), {
      tool_response: { exit_code: 0 },
    }).matched,
    true
  );
  assert.equal(
    _evaluatePostToolExit(makeMemory({ triggerPosttoolExit: 2 }), {
      tool_response: { exit_code: 2 },
    }).matched,
    true
  );
  assert.equal(
    _evaluatePostToolExit(makeMemory({ triggerPosttoolExit: 2 }), {
      tool_response: { exit_code: 3 },
    }).matched,
    false
  );
});

test('_evaluatePostToolExit reads order tool_response.exit_code -> .exitCode -> payload.exit_code', () => {
  const mem = makeMemory({ triggerPosttoolExit: 'nonzero' });
  // exitCode fallback
  assert.equal(_evaluatePostToolExit(mem, { tool_response: { exitCode: 1 } }).matched, true);
  // payload.exit_code fallback
  assert.equal(
    _evaluatePostToolExit(mem, { tool_response: {}, exit_code: 5 }).matched,
    true
  );
  // precedence: tool_response.exit_code wins over payload.exit_code
  assert.equal(
    _evaluatePostToolExit(mem, { tool_response: { exit_code: 0 }, exit_code: 1 }).matched,
    false
  );
});

test('_evaluatePostToolExit coerces numeric-STRING exit codes (string "1" == numeric 1)', () => {
  const mem = makeMemory({ triggerPosttoolExit: 'nonzero' });
  // tool_response.exit_code as a string
  assert.equal(_evaluatePostToolExit(mem, { tool_response: { exit_code: '1' } }).matched, true);
  // string "0" is still zero → nonzero gate rejects
  assert.equal(_evaluatePostToolExit(mem, { tool_response: { exit_code: '0' } }).matched, false);
  // string exitCode fallback
  assert.equal(_evaluatePostToolExit(mem, { tool_response: { exitCode: '2' } }).matched, true);
  // payload.exit_code string fallback
  assert.equal(
    _evaluatePostToolExit(mem, { tool_response: {}, exit_code: '7' }).matched,
    true
  );
  // non-numeric string is not a code → fail closed
  assert.equal(
    _evaluatePostToolExit(mem, { tool_response: { exit_code: 'boom' } }).matched,
    false
  );
});

test('_evaluatePostToolExit fails closed when no exit code is present', () => {
  const result = _evaluatePostToolExit(makeMemory({ triggerPosttoolExit: 'nonzero' }), {
    tool_response: 'no exit code anywhere',
  });
  assert.equal(result.matched, false);
});

test('matchPostTool exit gate fires on nonzero and returns no-exit-match on zero', () => {
  const memory = makeMemory({
    triggerPretool: ['Bash:pnpm test'],
    triggerPosttoolExit: 'nonzero',
  });
  const failing = run(memory, {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: '', stderr: 'FAIL', exit_code: 1 },
  });
  assert.equal(failing.fired, true);
  assert.equal(failing.matched.posttool_exit, 'nonzero');

  const passing = run(memory, {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'ok', stderr: '', exit_code: 0 },
  });
  assert.equal(passing.fired, false);
  assert.equal(passing.reason, 'no-exit-match');
});

test('matchPostTool exit gate fails closed (no-exit-match) when exit code absent', () => {
  const memory = makeMemory({
    triggerPretool: ['Bash:pnpm test'],
    triggerPosttoolExit: 'nonzero',
  });
  const result = run(memory, {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'no exit field' },
  });
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-exit-match');
});

test('matchPostTool fires trigger_posttool_exit:nonzero on a STRING exit_code "1" like numeric 1', () => {
  const memory = makeMemory({
    triggerPretool: ['Bash:pnpm test'],
    triggerPosttoolExit: 'nonzero',
  });
  const stringResult = run(memory, {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: '', stderr: 'FAIL', exit_code: '1' },
  });
  assert.equal(stringResult.fired, true);
  assert.equal(stringResult.matched.posttool_exit, 'nonzero');
});

// cursor[bot] Medium — an empty trigger_posttool_exit (normalized to null at
// parse time) imposes NO exit gate: a content-only memory fires on a NON-zero
// run the same as a zero run. Contrast with trigger_posttool_exit: 0, which
// still gates to exit 0 only (the empty field must NOT degrade into 0-gating).

test('empty (null) trigger_posttool_exit imposes no exit gate: fires on zero AND nonzero alike', () => {
  const memory = makeMemory({
    triggerPosttoolContent: ['boom'],
    triggerPosttoolExit: null, // what an empty `trigger_posttool_exit:` parses to
  });
  const onZero = run(memory, {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'boom', stderr: '', exit_code: 0 },
  });
  const onNonzero = run(memory, {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'boom', stderr: '', exit_code: 1 },
  });
  assert.equal(onZero.fired, true);
  assert.equal(onNonzero.fired, true);
});

test('trigger_posttool_exit: 0 still gates to exit 0 only (contrast with the empty field)', () => {
  const memory = makeMemory({
    triggerPosttoolContent: ['boom'],
    triggerPosttoolExit: 0,
  });
  const onZero = run(memory, {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'boom', stderr: '', exit_code: 0 },
  });
  const onNonzero = run(memory, {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm test' },
    tool_response: { stdout: 'boom', stderr: '', exit_code: 1 },
  });
  assert.equal(onZero.fired, true);
  assert.equal(onNonzero.fired, false);
  assert.equal(onNonzero.reason, 'no-exit-match');
});

// ---- gate / distinctness ----

test('matchPostTool respects the events gate (events-exclude)', () => {
  const result = run(makeMemory({ events: ['PreToolUse'] }), {
    tool_name: 'Bash',
    tool_input: {},
    tool_response: 'x',
  });
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'events-exclude');
});

test('matchPostTool reads tool_response, never tool_input (C-2)', () => {
  // Content pattern present only in tool_input must NOT fire; only tool_response counts.
  const memory = makeMemory({
    triggerPretool: ['Bash:'],
    triggerPosttoolContent: ['SECRET_IN_INPUT'],
  });
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'echo SECRET_IN_INPUT' },
    tool_response: { stdout: 'redacted', stderr: '' },
  };
  const result = run(memory, payload);
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'no-content-match');
});

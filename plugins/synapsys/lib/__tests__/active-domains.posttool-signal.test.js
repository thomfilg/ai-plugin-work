'use strict';

// PostToolUse domain-signal regression (PR #608 bot comment, GH-473).
//
// currentToolCallString previously dropped every non-PreToolUse event, so a
// PostToolUse payload's tool_name/tool_input never reached the signal_pretool
// classifier. Domain-tagged PostToolUse memories then saw an empty tool list
// and got wrongly domain-mismatched. PostToolUse carries the same tool surface
// as PreToolUse, so it must serialize identically and drive the same domain
// activation. These tests mirror the existing PreToolUse expectations.

const test = require('node:test');
const assert = require('node:assert/strict');

const { currentToolCallString, getRecentToolCallsWithCurrent } = require('../active-domains');
const { classifyActiveDomains } = require('../classifier');

function mkRegistry() {
  const roots = new Map();
  const ci = { leaves: new Map() };
  ci.leaves.set('failure-diagnosis', {
    signal_prompt: [/\bci\s+failure\b/i],
    signal_pretool: [/\bgh\s+run\s+view\b/i],
  });
  roots.set('ci', ci);
  return { roots };
}

test('currentToolCallString serializes a PostToolUse tool call', () => {
  const out = currentToolCallString('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'gh run view 123' },
  });
  assert.equal(out, 'Bash {"command":"gh run view 123"}');
});

test('PreToolUse and PostToolUse serialize identically', () => {
  const payload = { tool_name: 'Bash', tool_input: { command: 'gh run view 123' } };
  assert.equal(
    currentToolCallString('PostToolUse', payload),
    currentToolCallString('PreToolUse', payload)
  );
});

test('non-tool events still return null', () => {
  const payload = { tool_name: 'Bash', tool_input: { command: 'x' } };
  assert.equal(currentToolCallString('Stop', payload), null);
  assert.equal(currentToolCallString('UserPromptSubmit', payload), null);
  assert.equal(currentToolCallString('SessionStart', payload), null);
});

test('PostToolUse current tool call is included in recentToolCalls', () => {
  const calls = getRecentToolCallsWithCurrent('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'gh run view 123' },
    recentToolCalls: ['prior call'],
  });
  assert.deepEqual(calls, ['Bash {"command":"gh run view 123"}', 'prior call']);
});

test('PostToolUse tool call drives signal_pretool domain activation', () => {
  const registry = mkRegistry();
  const recentToolCalls = getRecentToolCallsWithCurrent('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'gh run view 123 --log' },
  });
  const out = classifyActiveDomains({ prompt: '', recentToolCalls, registry });
  assert.equal(out.has('ci'), true, 'root active via PostToolUse tool signal');
  assert.equal(out.has('ci:failure-diagnosis'), true, 'leaf active via PostToolUse tool signal');
});

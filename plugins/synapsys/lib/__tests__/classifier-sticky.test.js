'use strict';

// RED phase — Task 6 (GH-513): `classifyWithSticky` composes the pure
// classifier output with the sticky-state hysteresis (AC5 + AC6).
//
// Scenarios:
//   - Sticky-domain hysteresis keeps a domain active after the signal stops
//   - Sticky-domain drops after 3 quiet prompts

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyWithSticky } = require('../classifier');

function mkRegistry() {
  const roots = new Map();
  const git = { leaves: new Map() };
  git.leaves.set('plumbing-ops', {
    signal_prompt: [/\bgit\s+merge\b/i],
    signal_pretool: [/\bgit\s+rebase\b/i],
  });
  roots.set('git', git);
  return { roots };
}

test('Sticky-domain hysteresis keeps a domain active after the signal stops', () => {
  const registry = mkRegistry();
  const sessionId = 'sess-hyst';
  let state = {};
  let now = 1_000_000;

  // 3 consecutive active prompts.
  for (let i = 0; i < 3; i++) {
    const r = classifyWithSticky({
      prompt: 'please git merge feature',
      recentToolCalls: [],
      registry,
      stickyState: state,
      sessionId,
      now: now + i * 1000,
    });
    assert.ok(r.activeDomains instanceof Set, 'activeDomains is a Set');
    assert.ok(r.activeDomains.has('git'), `prompt ${i + 1} should include git root`);
    state = r.nextStickyState;
  }

  // 1 quiet prompt — domain should remain active via sticky hysteresis.
  const quiet = classifyWithSticky({
    prompt: 'unrelated message',
    recentToolCalls: [],
    registry,
    stickyState: state,
    sessionId,
    now: now + 10_000,
  });
  assert.ok(
    quiet.activeDomains.has('git'),
    'git should remain active after 1 quiet prompt (AC5 hysteresis)'
  );
});

test('Sticky-domain drops after 3 quiet prompts', () => {
  const registry = mkRegistry();
  const sessionId = 'sess-drop';
  let state = {};
  let now = 2_000_000;

  // Establish sticky: 3 active prompts.
  for (let i = 0; i < 3; i++) {
    const r = classifyWithSticky({
      prompt: 'time to git merge main',
      recentToolCalls: [],
      registry,
      stickyState: state,
      sessionId,
      now: now + i * 1000,
    });
    state = r.nextStickyState;
  }

  // 3 consecutive quiet prompts.
  let last;
  for (let i = 0; i < 3; i++) {
    last = classifyWithSticky({
      prompt: 'something else entirely',
      recentToolCalls: [],
      registry,
      stickyState: state,
      sessionId,
      now: now + 100_000 + i * 1000,
    });
    state = last.nextStickyState;
  }

  assert.ok(
    !last.activeDomains.has('git'),
    'git should drop from active set after 3 quiet prompts (AC6)'
  );
});

'use strict';

// RED phase — Task 7 (GH-513): Extend matcher.selectForEvent with
// `opts.activeDomains` gate. The new optional 4th arg gates memories with
// a non-empty `domain: string[]` field: if its intersection with the active
// set is empty, the memory is excluded with reason `domain-mismatch` —
// BEFORE trigger evaluation runs. Memories without a domain (or when the
// caller omits opts.activeDomains) keep the legacy behavior (R10/AC1).
//
// Scenarios pinned here:
//   - Memory with non-overlapping domain is skipped even when trigger matches
//   - Memory with overlapping domain fires when trigger matches
//   - Memory with empty domain fires regardless of activeDomains
//   - opts.activeDomains omitted -> behavior unchanged

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { selectForEvent } = require(path.resolve(__dirname, '..', 'matcher'));

function makeMemory(overrides) {
  return Object.assign(
    {
      name: 'm',
      events: ['UserPromptSubmit'],
      triggerPrompt: '\\bdeploy\\b',
      triggerPretool: [],
      triggerSession: false,
      domain: [],
    },
    overrides
  );
}

test('Memory with non-overlapping domain is skipped even when trigger matches', () => {
  const memory = makeMemory({
    name: 'git-only',
    domain: ['git'],
    triggerPrompt: '\\bdeploy\\b',
  });
  const picked = selectForEvent([memory], 'UserPromptSubmit', { prompt: 'please deploy now' }, {
    activeDomains: new Set(['e2e']),
  });
  assert.deepEqual(
    picked.map((m) => m.name),
    [],
    'memory with domain=[git] must be skipped when active=[e2e], even though prompt matches trigger'
  );
});

test('Memory with overlapping domain fires when trigger matches', () => {
  const memory = makeMemory({
    name: 'git-mem',
    domain: ['git'],
    triggerPrompt: '\\bdeploy\\b',
  });
  const picked = selectForEvent([memory], 'UserPromptSubmit', { prompt: 'please deploy now' }, {
    activeDomains: new Set(['git', 'ci']),
  });
  assert.deepEqual(picked.map((m) => m.name), ['git-mem']);
});

test('Memory with empty domain fires regardless of activeDomains (backward compat R10)', () => {
  const memory = makeMemory({
    name: 'universal',
    domain: [],
    triggerPrompt: '\\bdeploy\\b',
  });
  const picked = selectForEvent([memory], 'UserPromptSubmit', { prompt: 'please deploy now' }, {
    activeDomains: new Set(['e2e']),
  });
  assert.deepEqual(picked.map((m) => m.name), ['universal']);
});

test('opts.activeDomains omitted leaves selection unchanged (backward compat)', () => {
  const memory = makeMemory({
    name: 'git-mem',
    domain: ['git'],
    triggerPrompt: '\\bdeploy\\b',
  });
  // No 4th arg at all
  const picked = selectForEvent([memory], 'UserPromptSubmit', { prompt: 'please deploy now' });
  assert.deepEqual(picked.map((m) => m.name), ['git-mem']);
});

test('opts.activeDomains undefined leaves selection unchanged (backward compat)', () => {
  const memory = makeMemory({
    name: 'git-mem',
    domain: ['git'],
    triggerPrompt: '\\bdeploy\\b',
  });
  const picked = selectForEvent([memory], 'UserPromptSubmit', { prompt: 'please deploy now' }, {});
  assert.deepEqual(picked.map((m) => m.name), ['git-mem']);
});

test('Multi-domain OR: fires when any listed domain is active (R6)', () => {
  const memory = makeMemory({
    name: 'multi',
    domain: ['git', 'ci'],
    triggerPrompt: '\\bdeploy\\b',
  });
  const picked = selectForEvent([memory], 'UserPromptSubmit', { prompt: 'please deploy now' }, {
    activeDomains: new Set(['ci']),
  });
  assert.deepEqual(picked.map((m) => m.name), ['multi']);
});

test('Mixed batch: domain-tagged memory filtered while untagged passes', () => {
  const memories = [
    makeMemory({ name: 'tagged-skip', domain: ['git'] }),
    makeMemory({ name: 'tagged-fire', domain: ['e2e'] }),
    makeMemory({ name: 'untagged', domain: [] }),
  ];
  const picked = selectForEvent(
    memories,
    'UserPromptSubmit',
    { prompt: 'please deploy now' },
    { activeDomains: new Set(['e2e']) }
  );
  assert.deepEqual(picked.map((m) => m.name).sort(), ['tagged-fire', 'untagged']);
});

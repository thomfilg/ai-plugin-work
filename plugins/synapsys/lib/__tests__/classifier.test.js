'use strict';

// RED phase — Task 4 (GH-513): `lib/classifier.js` pure-regex `classifyActiveDomains`.
//
// Unit tests cover:
//   - single leaf match emits BOTH root + root:leaf into the active set
//   - two leaves in the same root emit one root + both leaves
//   - cross-root matches union (OR semantics over multiple roots)
//   - recentToolCalls strings match signal_pretool patterns
//   - null/undefined/empty inputs return an empty set
//   - Inheritance — memory tagged with parent matches when any leaf is active
//   - Multi-domain OR semantics — memory fires when any listed domain is active

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyActiveDomains } = require('../classifier');

function mkRegistry() {
  const roots = new Map();
  const e2e = { leaves: new Map() };
  e2e.leaves.set('local-execution', {
    signal_prompt: [/\be2e\b/i],
    signal_pretool: [/\bplaywright\s+test\b/i],
  });
  e2e.leaves.set('flake-triage', {
    signal_prompt: [/\bflake\b/i],
    signal_pretool: [/\bplaywright\s+test\s+--retries\b/i],
  });
  roots.set('e2e', e2e);

  const git = { leaves: new Map() };
  git.leaves.set('plumbing-ops', {
    signal_prompt: [/\bgit\s+merge\b/i],
    signal_pretool: [/\bgit\s+rebase\b/i],
  });
  roots.set('git', git);

  const ci = { leaves: new Map() };
  ci.leaves.set('failure-diagnosis', {
    signal_prompt: [/\bci\s+failure\b/i],
    signal_pretool: [/\bgh\s+run\s+view\b/i],
  });
  roots.set('ci', ci);

  return { roots };
}

test('single leaf match emits root + leaf', () => {
  const registry = mkRegistry();
  const out = classifyActiveDomains({
    prompt: 'please run git merge feature/x',
    recentToolCalls: [],
    registry,
  });
  assert.ok(out instanceof Set, 'returns a Set');
  assert.equal(out.has('git'), true, 'root present');
  assert.equal(out.has('git:plumbing-ops'), true, 'leaf present');
  assert.equal(out.size, 2);
});

test('two leaves in same root emit root + both leaves', () => {
  const registry = mkRegistry();
  const out = classifyActiveDomains({
    prompt: 'e2e test is a flake again',
    recentToolCalls: [],
    registry,
  });
  assert.equal(out.has('e2e'), true);
  assert.equal(out.has('e2e:local-execution'), true);
  assert.equal(out.has('e2e:flake-triage'), true);
  assert.equal(out.size, 3, 'no duplicate roots');
});

test('cross-root emits both roots (union)', () => {
  const registry = mkRegistry();
  const out = classifyActiveDomains({
    prompt: 'git merge then check ci failure',
    recentToolCalls: [],
    registry,
  });
  assert.equal(out.has('git'), true);
  assert.equal(out.has('git:plumbing-ops'), true);
  assert.equal(out.has('ci'), true);
  assert.equal(out.has('ci:failure-diagnosis'), true);
});

test('recentToolCalls match signal_pretool', () => {
  const registry = mkRegistry();
  const out = classifyActiveDomains({
    prompt: 'no signal here',
    recentToolCalls: ['playwright test --retries=2'],
    registry,
  });
  assert.equal(out.has('e2e'), true);
  assert.equal(out.has('e2e:local-execution'), true);
  assert.equal(out.has('e2e:flake-triage'), true);
});

test('null/undefined prompt returns empty set', () => {
  const registry = mkRegistry();
  const a = classifyActiveDomains({ prompt: null, recentToolCalls: [], registry });
  const b = classifyActiveDomains({ prompt: undefined, recentToolCalls: undefined, registry });
  const c = classifyActiveDomains({ prompt: '', recentToolCalls: [], registry });
  assert.equal(a.size, 0);
  assert.equal(b.size, 0);
  assert.equal(c.size, 0);
});

test('empty registry returns empty set', () => {
  const out = classifyActiveDomains({
    prompt: 'git merge feature/x',
    recentToolCalls: ['playwright test'],
    registry: { roots: new Map() },
  });
  assert.equal(out.size, 0);
});

test('Inheritance — memory tagged with parent matches when any leaf is active', () => {
  // A memory tagged `domain: git` should match if ANY git leaf is active.
  // The classifier's contract: a leaf hit emits BOTH root + root:leaf, so a
  // consumer filtering `activeDomains.has('git')` sees the parent fire.
  const registry = mkRegistry();
  const out = classifyActiveDomains({
    prompt: 'running git merge feature/x',
    recentToolCalls: [],
    registry,
  });
  // Parent tag `git` is in the active set because a leaf matched.
  assert.equal(out.has('git'), true, 'parent root active via leaf match');
  // Demonstrate the inheritance contract independently of which leaf matched.
  const out2 = classifyActiveDomains({
    prompt: 'no prompt signal',
    recentToolCalls: ['git rebase -i HEAD~3'],
    registry,
  });
  assert.equal(out2.has('git'), true, 'parent root active via pretool leaf match');
  assert.equal(out2.has('git:plumbing-ops'), true);
});

test('Multi-domain OR semantics — memory fires when any listed domain is active', () => {
  // A memory tagged `domain: [e2e:flake-triage, ci:failure-diagnosis]` should
  // fire if EITHER is in the active set. We assert each of the two domains
  // independently appears in the active set when its own signal fires.
  const registry = mkRegistry();

  const onlyFlake = classifyActiveDomains({
    prompt: 'flake again',
    recentToolCalls: [],
    registry,
  });
  assert.equal(onlyFlake.has('e2e:flake-triage'), true);
  assert.equal(onlyFlake.has('ci:failure-diagnosis'), false);
  // OR semantics: presence of e2e:flake-triage alone is enough for the listed
  // memory to fire.
  const tagged = ['e2e:flake-triage', 'ci:failure-diagnosis'];
  assert.equal(tagged.some((d) => onlyFlake.has(d)), true);

  const onlyCi = classifyActiveDomains({
    prompt: 'ci failure on main',
    recentToolCalls: [],
    registry,
  });
  assert.equal(onlyCi.has('ci:failure-diagnosis'), true);
  assert.equal(onlyCi.has('e2e:flake-triage'), false);
  assert.equal(tagged.some((d) => onlyCi.has(d)), true);
});

'use strict';

// RED phase — Task 4 (GH-513) INTEGRATION.
//
// Loads the real seeded `lib/DOMAINS.md` via `loadDomainRegistry()` and runs
// representative prompts end-to-end through `classifyActiveDomains`, asserting
// the expected root+leaf sets emerge.
//
// Covers (verbatim scenario titles below):
//   - Inheritance — memory tagged with parent matches when any leaf is active
//   - Multi-domain OR semantics — memory fires when any listed domain is active

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadDomainRegistry, _resetDomainCache } = require('../domains');
const { classifyActiveDomains } = require('../classifier');

function freshRegistry() {
  _resetDomainCache();
  return loadDomainRegistry();
}

test('integration: "git merge feature/x" emits git + git:plumbing-ops', () => {
  const registry = freshRegistry();
  const out = classifyActiveDomains({
    prompt: 'git merge feature/x',
    recentToolCalls: [],
    registry,
  });
  assert.equal(out.has('git'), true);
  assert.equal(out.has('git:plumbing-ops'), true);
});

test('integration: "e2e test failed" emits e2e + e2e:local-execution', () => {
  const registry = freshRegistry();
  const out = classifyActiveDomains({
    prompt: 'e2e test failed',
    recentToolCalls: [],
    registry,
  });
  assert.equal(out.has('e2e'), true);
  assert.equal(out.has('e2e:local-execution'), true);
});

test('integration: Inheritance — memory tagged with parent matches when any leaf is active', () => {
  // Worked example from DOMAINS.md: prompt "git merge feature/x" → active
  // domains include `git` (parent) AND `git:plumbing-ops` (leaf). A memory
  // tagged `domain: git` fires via the parent-in-active-set contract.
  const registry = freshRegistry();
  const out = classifyActiveDomains({
    prompt: 'git merge feature/x',
    recentToolCalls: [],
    registry,
  });
  assert.equal(out.has('git'), true, 'parent in active set so `domain: git` memories fire');
  assert.equal(out.has('git:plumbing-ops'), true);

  // Same inheritance contract via pretool signal on a different leaf:
  const out2 = classifyActiveDomains({
    prompt: 'no prompt signal here',
    recentToolCalls: ['playwright test e2e/login.spec.ts'],
    registry,
  });
  assert.equal(out2.has('e2e'), true, 'parent `e2e` active via leaf pretool match');
  assert.equal(out2.has('e2e:local-execution'), true);
});

test('integration: Multi-domain OR semantics — memory fires when any listed domain is active', () => {
  // Worked example from DOMAINS.md: a memory tagged
  // `domain: [e2e:flake-triage, ci:failure-diagnosis]` fires when EITHER
  // domain is active.
  const registry = freshRegistry();
  const tagged = ['e2e:flake-triage', 'ci:failure-diagnosis'];

  const flakeOnly = classifyActiveDomains({
    prompt: 'this is a flake',
    recentToolCalls: [],
    registry,
  });
  assert.equal(flakeOnly.has('e2e:flake-triage'), true);
  assert.equal(
    tagged.some((d) => flakeOnly.has(d)),
    true,
    'fires via e2e:flake-triage'
  );

  const ciOnly = classifyActiveDomains({
    prompt: 'ci failure on main',
    recentToolCalls: [],
    registry,
  });
  assert.equal(ciOnly.has('ci:failure-diagnosis'), true);
  assert.equal(
    tagged.some((d) => ciOnly.has(d)),
    true,
    'fires via ci:failure-diagnosis'
  );
});

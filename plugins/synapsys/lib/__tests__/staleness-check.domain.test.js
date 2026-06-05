'use strict';

// RED phase — Task 11 (GH-513): Extend `synapsys-staleness-check` to lint
// unknown domains.
//
// These unit tests exercise the pure helper the script exports for
// classifying a memory's `domain:` values against the domain registry.
// AC for Task 11:
//   - Warn when any value is not present in the registry (root or root:leaf).
//   - --strict surfaces as a non-zero exit at the CLI layer (integration).
//   - Backward-compat: memories without `domain:` produce no warnings.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const STALENESS_SCRIPT = path.resolve(
  __dirname,
  '..',
  '..',
  'scripts',
  'synapsys-staleness-check.js'
);

// Build a small registry shaped like loadDomainRegistry() output.
// roots: Map<string, { leaves: Map<string, { signal_prompt, signal_pretool }> }>
function makeRegistry(spec) {
  const roots = new Map();
  for (const [rootName, leaves] of Object.entries(spec)) {
    const leafMap = new Map();
    for (const leafName of leaves) {
      leafMap.set(leafName, { signal_prompt: [], signal_pretool: [] });
    }
    roots.set(rootName, { leaves: leafMap });
  }
  return { roots };
}

const REGISTRY = makeRegistry({
  e2e: ['local-execution', 'flake-triage'],
  git: ['plumbing-ops'],
});

// Scenario coverage: "Lint warns when a memory references an unknown domain"
test('Lint warns when a memory references an unknown domain — unknown root', () => {
  const { lintDomainsForMemory } = require(STALENESS_SCRIPT);
  assert.equal(typeof lintDomainsForMemory, 'function', 'helper is exported');
  const warnings = lintDomainsForMemory(
    { name: 'mem-bad-root', domain: ['nope'] },
    REGISTRY
  );
  assert.equal(warnings.length, 1, 'one warning for one unknown value');
  const w = warnings[0];
  assert.equal(w.memory, 'mem-bad-root');
  assert.equal(w.value, 'nope');
});

test('Lint warns when a memory references an unknown domain — unknown leaf under known root', () => {
  const { lintDomainsForMemory } = require(STALENESS_SCRIPT);
  const warnings = lintDomainsForMemory(
    { name: 'mem-bad-leaf', domain: ['e2e:nonexistent-leaf'] },
    REGISTRY
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].memory, 'mem-bad-leaf');
  assert.equal(warnings[0].value, 'e2e:nonexistent-leaf');
});

test('no warning when memory references a known root', () => {
  const { lintDomainsForMemory } = require(STALENESS_SCRIPT);
  const warnings = lintDomainsForMemory(
    { name: 'mem-root', domain: ['e2e'] },
    REGISTRY
  );
  assert.deepEqual(warnings, []);
});

test('no warning when memory references a known root:leaf', () => {
  const { lintDomainsForMemory } = require(STALENESS_SCRIPT);
  const warnings = lintDomainsForMemory(
    { name: 'mem-leaf', domain: ['e2e:flake-triage'] },
    REGISTRY
  );
  assert.deepEqual(warnings, []);
});

test('backward-compat: memory without `domain:` produces no warnings', () => {
  const { lintDomainsForMemory } = require(STALENESS_SCRIPT);
  assert.deepEqual(
    lintDomainsForMemory({ name: 'mem-none', domain: [] }, REGISTRY),
    []
  );
  // undefined domain too
  assert.deepEqual(
    lintDomainsForMemory({ name: 'mem-undef' }, REGISTRY),
    []
  );
});

test('mixed valid/invalid: only invalid values produce warnings', () => {
  const { lintDomainsForMemory } = require(STALENESS_SCRIPT);
  const warnings = lintDomainsForMemory(
    { name: 'mem-mixed', domain: ['e2e', 'bogus', 'git:plumbing-ops', 'git:no-such'] },
    REGISTRY
  );
  const values = warnings.map((w) => w.value).sort();
  assert.deepEqual(values, ['bogus', 'git:no-such']);
  for (const w of warnings) {
    assert.equal(w.memory, 'mem-mixed');
  }
});

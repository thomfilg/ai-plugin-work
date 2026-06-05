'use strict';

// RED phase — Task 3 (GH-513): Seed bundled `lib/DOMAINS.md` registry.
//
// Asserts that the bundled `plugins/synapsys/lib/DOMAINS.md`:
//   - parses cleanly via Task 2's `loadDomainRegistry()`;
//   - contains every required root + leaf
//     (e2e:{local-execution,test-authoring,flake-triage},
//      git:{plumbing-ops,conflict-resolve,history-edit},
//      ci:{monitor-active,failure-diagnosis,retry-decision},
//      ticket-ops:{write,close,read},
//      code-author:{react,trpc,prisma,zod});
//   - each leaf has ≥1 `signal_prompt` and ≥1 `signal_pretool` regex;
//   - every regex source contains `\b…\b` word-boundary discipline (R8);
//   - includes a worked-example section (R13) and authoring-guidance section (R14).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadDomainRegistry, _resetDomainCache } = require('../domains');

const BUNDLED_PATH = path.join(__dirname, '..', 'DOMAINS.md');

const EXPECTED = {
  e2e: ['local-execution', 'test-authoring', 'flake-triage'],
  git: ['plumbing-ops', 'conflict-resolve', 'history-edit'],
  ci: ['monitor-active', 'failure-diagnosis', 'retry-decision'],
  'ticket-ops': ['write', 'close', 'read'],
  'code-author': ['react', 'trpc', 'prisma', 'zod'],
};

function loadBundled() {
  _resetDomainCache();
  // Point `home` at an empty tmpdir so user-file lookup misses and we fall
  // back to the bundled file under test.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-domains-seed-'));
  return loadDomainRegistry({ home, bundledPath: BUNDLED_PATH });
}

test('bundled DOMAINS.md file exists at lib/DOMAINS.md', () => {
  assert.ok(fs.existsSync(BUNDLED_PATH), `expected bundled registry at ${BUNDLED_PATH}`);
});

test('bundled registry parses via loadDomainRegistry()', () => {
  const registry = loadBundled();
  assert.ok(registry && registry.roots instanceof Map, 'registry.roots is a Map');
  assert.ok(registry.roots.size > 0, 'registry has at least one root');
});

for (const [root, leaves] of Object.entries(EXPECTED)) {
  test(`bundled registry contains root "${root}" with expected leaves`, () => {
    const registry = loadBundled();
    assert.ok(registry.roots.has(root), `root "${root}" present`);
    const rootEntry = registry.roots.get(root);
    assert.ok(rootEntry.leaves instanceof Map, `root "${root}" has leaves Map`);
    for (const leaf of leaves) {
      assert.ok(
        rootEntry.leaves.has(leaf),
        `root "${root}" missing leaf "${leaf}"`,
      );
    }
  });

  for (const leaf of leaves) {
    test(`leaf ${root}:${leaf} has ≥1 signal_prompt and ≥1 signal_pretool regex`, () => {
      const registry = loadBundled();
      const leafEntry = registry.roots.get(root).leaves.get(leaf);
      assert.ok(
        Array.isArray(leafEntry.signal_prompt) && leafEntry.signal_prompt.length >= 1,
        `${root}:${leaf} missing signal_prompt`,
      );
      assert.ok(
        Array.isArray(leafEntry.signal_pretool) && leafEntry.signal_pretool.length >= 1,
        `${root}:${leaf} missing signal_pretool`,
      );
    });

    test(`leaf ${root}:${leaf} regex sources use \\b word boundaries (R8)`, () => {
      const registry = loadBundled();
      const leafEntry = registry.roots.get(root).leaves.get(leaf);
      const all = [...leafEntry.signal_prompt, ...leafEntry.signal_pretool];
      for (const re of all) {
        assert.ok(
          re.source.includes('\\b'),
          `${root}:${leaf} pattern /${re.source}/ missing \\b boundary`,
        );
      }
    });
  }
}

test('bundled DOMAINS.md includes a worked-example section (R13)', () => {
  const body = fs.readFileSync(BUNDLED_PATH, 'utf8');
  assert.match(
    body,
    /worked[- ]example/i,
    'expected a worked-example heading/section in DOMAINS.md',
  );
  // R13 calls for at least two prompt → active-domains → memories-fired tables.
  // Look for at least two markdown tables (lines starting with `|`).
  const tableRowMatches = body.match(/^\|.*\|\s*$/gm) || [];
  assert.ok(
    tableRowMatches.length >= 4, // at least two tables, header + ≥1 row each
    `expected ≥2 markdown tables in worked-example section, found ${tableRowMatches.length} rows`,
  );
});

test('bundled DOMAINS.md includes an authoring-guidance section (R14)', () => {
  const body = fs.readFileSync(BUNDLED_PATH, 'utf8');
  assert.match(
    body,
    /authoring[- ]guidance|authoring guidance/i,
    'expected an authoring-guidance heading/section',
  );
  // Sanity: it should mention narrowest leaf, multi-domain, and universal rules.
  assert.match(body, /narrowest/i, 'authoring guidance mentions narrowest leaf');
  assert.match(body, /multi[- ]domain|multiple domains/i, 'authoring guidance mentions multi-domain');
  assert.match(body, /universal/i, 'authoring guidance mentions universal rules');
});

'use strict';

// RED phase — Task 3 (GH-513): Seed bundled `lib/DOMAINS.md` registry.
//
// Integration test (3.1.4): drives representative prompts through Task 2's
// `loadDomainRegistry()` + Task 4's `classifyActiveDomains()` against the
// real seeded `lib/DOMAINS.md`, asserting the expected root+leaf sets
// emerge end-to-end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadDomainRegistry, _resetDomainCache } = require('../domains');

const BUNDLED_PATH = path.join(__dirname, '..', 'DOMAINS.md');

function loadSeed() {
  _resetDomainCache();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-domains-seed-int-'));
  return loadDomainRegistry({ home, bundledPath: BUNDLED_PATH });
}

// Task 4's classifier is imported lazily so this file can be authored before
// Task 4 lands. When `lib/classifier.js` is absent the classifier-driven
// assertions are skipped (Task 3 only depends on Task 2 per tasks.md); when
// it lands these become the binding integration contract.
function tryLoadClassifier() {
  try {
    // eslint-disable-next-line global-require
    return require('../classifier');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

// End-to-end fs-backed sanity: the bundled DOMAINS.md must parse via the real
// `loadDomainRegistry()` (no in-memory fixture) and produce regexes that
// actually match the representative prompts. This validates Task 3's seeded
// file independent of Task 4's classifier landing.
function findMatchingLeaves(registry, prompt) {
  /** @type {Array<{ root: string, leaf: string }>} */
  const hits = [];
  for (const [root, rootEntry] of registry.roots) {
    for (const [leaf, leafEntry] of rootEntry.leaves) {
      for (const re of leafEntry.signal_prompt) {
        if (re.test(prompt)) {
          hits.push({ root, leaf });
          break;
        }
      }
    }
  }
  return hits;
}

test('seeded fs-backed registry: "git merge feature/x" matches git:plumbing-ops via signal_prompt', () => {
  const registry = loadSeed();
  const hits = findMatchingLeaves(registry, 'git merge feature/x');
  const matched = hits.some((h) => h.root === 'git' && h.leaf === 'plumbing-ops');
  assert.ok(matched, `expected git:plumbing-ops match; got ${JSON.stringify(hits)}`);
});

test('seeded fs-backed registry: "e2e test failed locally" matches at least one e2e:* leaf', () => {
  const registry = loadSeed();
  const hits = findMatchingLeaves(registry, 'e2e test failed locally');
  const matched = hits.some((h) => h.root === 'e2e');
  assert.ok(matched, `expected some e2e:* match; got ${JSON.stringify(hits)}`);
});

test('seeded fs-backed registry: "npx prisma migrate" matches code-author:prisma', () => {
  const registry = loadSeed();
  const hits = findMatchingLeaves(registry, 'npx prisma migrate');
  const matched = hits.some((h) => h.root === 'code-author' && h.leaf === 'prisma');
  assert.ok(matched, `expected code-author:prisma match; got ${JSON.stringify(hits)}`);
});

test('seeded registry + classifier (when Task 4 lands): "git merge" → git + git:plumbing-ops', (t) => {
  const classifier = tryLoadClassifier();
  if (!classifier) {
    t.skip('lib/classifier.js (Task 4) not yet present');
    return;
  }
  const registry = loadSeed();
  const active = classifier.classifyActiveDomains({
    prompt: 'git merge feature/x',
    recentToolCalls: [],
    registry,
  });
  assert.ok(active.has('git'), 'root "git" active');
  assert.ok(active.has('git:plumbing-ops'), 'leaf "git:plumbing-ops" active');
});

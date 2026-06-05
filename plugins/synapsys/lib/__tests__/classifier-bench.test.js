'use strict';

// CHECKPOINT bench (GH-513 Task 12): pin classifier p99 under the <5ms budget
// stated in lib/classifier.js. Loads the seeded `lib/DOMAINS.md` registry via
// loadDomainRegistry() with a fake $HOME so the user-file branch is skipped
// and the bundled file is used deterministically.
//
// 100 warm-up iterations + 1000 measured iterations over a ~20-prompt corpus
// covering each registry root (e2e, git, ci, ticket-ops, code-author) plus
// no-match noise. p99 is `sorted[Math.floor(0.99 * len)]`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { loadDomainRegistry, _resetDomainCache } = require(
  path.resolve(__dirname, '..', 'domains')
);
const { classifyActiveDomains } = require(
  path.resolve(__dirname, '..', 'classifier')
);

test('classifier p99 stays under 5ms across a representative corpus', () => {
  // Point loadDomainRegistry at a fresh tmp $HOME so the user-file branch
  // misses and the bundled DOMAINS.md is used deterministically.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-bench-'));
  _resetDomainCache();
  const registry = loadDomainRegistry({ home: tmpHome });
  // Sanity: the bundled registry must have loaded — otherwise the bench is
  // measuring an empty-Set fast-path and would silently pass.
  assert.ok(registry.roots.size >= 4, 'bundled DOMAINS.md must be loaded');

  const corpus = [
    // git
    'git merge feature/x',
    'fix merge conflict in src/app.ts',
    'do an interactive rebase to squash',
    // e2e
    'e2e test failed locally',
    'write e2e for the checkout flow',
    'looks like a flake in the playwright suite',
    // ci
    'ci status looks red',
    'investigate ci failure on PR 42',
    'rerun ci on the latest commit',
    // ticket-ops
    'create a ticket for the regression',
    'close the issue once merged',
    'read the ticket description first',
    // code-author
    'add a react component for the banner',
    'wire up trpc router for users',
    'update prisma schema and migrate',
    'validate input with zod',
    // noise / no-match
    'lunch plans for tomorrow',
    'what is the weather today',
    'please summarize the document',
    'remind me to call back later',
  ];

  // Pretool corpus to exercise the pretool path too.
  const toolCorpus = [
    [],
    ['playwright test --grep checkout'],
    ['git rebase main'],
    ['gh run watch 12345'],
    ['gh issue create --title foo'],
    ['prisma migrate dev'],
  ];

  // Warm-up: 100 iterations to let V8 inline matchesAny / iterateLeafSignals.
  for (let i = 0; i < 100; i++) {
    const prompt = corpus[i % corpus.length];
    classifyActiveDomains({ prompt, recentToolCalls: [], registry });
  }

  const N = 1000;
  const samples = new Array(N);
  for (let i = 0; i < N; i++) {
    const prompt = corpus[Math.floor(Math.random() * corpus.length)];
    const tools = toolCorpus[Math.floor(Math.random() * toolCorpus.length)];
    const t0 = performance.now();
    classifyActiveDomains({ prompt, recentToolCalls: tools, registry });
    const t1 = performance.now();
    samples[i] = t1 - t0;
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(0.5 * N)];
  const p99 = samples[Math.floor(0.99 * N)];
  const max = samples[N - 1];

  // eslint-disable-next-line no-console
  console.log(
    `classifier bench: p50=${p50.toFixed(4)}ms p99=${p99.toFixed(4)}ms max=${max.toFixed(4)}ms (N=${N})`
  );

  assert.ok(
    p99 < 5,
    `p99 must be < 5ms (got p99=${p99.toFixed(4)}ms, p50=${p50.toFixed(4)}ms, max=${max.toFixed(4)}ms)`
  );

  fs.rmSync(tmpHome, { recursive: true, force: true });
});

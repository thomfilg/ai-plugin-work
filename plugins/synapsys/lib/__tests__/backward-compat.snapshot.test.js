'use strict';

// CHECKPOINT snapshot (GH-513 Task 13): pin R10 backward compatibility for
// memories with NO `domain:` field. A memory store carrying only untagged
// memories must produce IDENTICAL `selectForEvent` output whether or not the
// caller supplies `opts.activeDomains`. The third subtest then confirms the
// gate IS active for memories that DO carry a domain tag, so the no-op is
// genuinely scoped to the untagged case (not just broken-everywhere).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore, MARKER, FOLDER } = require(
  path.resolve(__dirname, '..', 'memory-store')
);
const { selectForEvent, isDomainMismatch } = require(
  path.resolve(__dirname, '..', 'matcher')
);

const SAMPLE_PROMPT = 'please git merge feature/x and then deploy';

let tmpRoot;
let store;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-bc-'));
  const storeDir = path.join(tmpRoot, '.claude', FOLDER);
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, MARKER),
    JSON.stringify({ kind: 'local', schemaVersion: 1 })
  );

  // Two untagged memories whose trigger_prompt will match SAMPLE_PROMPT.
  fs.writeFileSync(
    path.join(storeDir, 'universal-merge.md'),
    [
      '---',
      'name: universal-merge',
      'description: untagged merge advice',
      'events: UserPromptSubmit',
      'trigger_prompt: \\bgit\\s+merge\\b',
      'inject: summary',
      '---',
      'Prefer rebase over merge on feature branches.',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(storeDir, 'universal-deploy.md'),
    [
      '---',
      'name: universal-deploy',
      'description: untagged deploy reminder',
      'events: UserPromptSubmit',
      'trigger_prompt: \\bdeploy\\b',
      'inject: summary',
      '---',
      'Always run smoke tests before deploy.',
    ].join('\n')
  );

  store = { kind: 'local', dir: storeDir, projectName: 'snapshot-proj' };
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('R10 backward compatibility — domain-less memories are unaffected by the gate', () => {
  it('baseline: selection with no opts.activeDomains picks both untagged memories', () => {
    const memories = listMemoriesFromStore(store);
    const picked = selectForEvent(
      memories,
      'UserPromptSubmit',
      { prompt: SAMPLE_PROMPT },
      {}
    ).map((m) => m.name).sort();

    // In-test snapshot baseline (no separate snapshot file).
    const baseline = ['universal-deploy', 'universal-merge'];
    assert.deepEqual(picked, baseline, 'baseline must include both untagged memories');
  });

  it('passing activeDomains is a no-op for untagged memories (matches baseline)', () => {
    const memories = listMemoriesFromStore(store);
    const baseline = selectForEvent(
      memories,
      'UserPromptSubmit',
      { prompt: SAMPLE_PROMPT },
      {}
    ).map((m) => m.name).sort();

    const gated = selectForEvent(
      memories,
      'UserPromptSubmit',
      { prompt: SAMPLE_PROMPT },
      { activeDomains: new Set(['e2e', 'git']) }
    ).map((m) => m.name).sort();

    assert.deepEqual(gated, baseline, 'untagged memories must be unaffected by activeDomains');
  });

  it('control: adding domain:[git] to one memory excludes it under activeDomains=Set([e2e]) with reason domain-mismatch', () => {
    const memories = listMemoriesFromStore(store);
    // Mutate one in-memory record to carry a domain tag — exercises the gate
    // without rewriting the on-disk frontmatter, which is out of scope here.
    const target = memories.find((m) => m.name === 'universal-merge');
    assert.ok(target, 'universal-merge must be present');
    target.domain = ['git'];

    // Reason check via the exported predicate — selectForEvent itself returns
    // memories not reasons, so we assert the gate fires with the expected
    // semantics (matches `domain-mismatch` per matcher.js Task 7).
    assert.equal(
      isDomainMismatch(target, new Set(['e2e'])),
      true,
      'domain=[git] vs active=[e2e] must trip the domain-mismatch gate'
    );

    const picked = selectForEvent(
      memories,
      'UserPromptSubmit',
      { prompt: SAMPLE_PROMPT },
      { activeDomains: new Set(['e2e']) }
    ).map((m) => m.name).sort();

    assert.deepEqual(
      picked,
      ['universal-deploy'],
      'tagged memory must be excluded; untagged peer must still fire'
    );
  });
});

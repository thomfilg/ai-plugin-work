'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classify,
  hasActionableBlockers,
  MERGEABLE_STATES,
  RUNNING_STATUSES,
} = require('../pr-mergeable');

// --- Fixture builders -------------------------------------------------------

function rollupEntry({ name = 'check', conclusion, status = 'COMPLETED', state } = {}) {
  const out = { name };
  if (conclusion !== undefined) out.conclusion = conclusion;
  if (status !== undefined) out.status = status;
  if (state !== undefined) out.state = state;
  return out;
}

const SUCCESS = (name) => rollupEntry({ name, conclusion: 'SUCCESS' });
const NEUTRAL = (name) => rollupEntry({ name, conclusion: 'NEUTRAL' });
const SKIPPED = (name) => rollupEntry({ name, conclusion: 'SKIPPED' });
const FAILURE = (name) => rollupEntry({ name, conclusion: 'FAILURE' });
const CANCELLED = (name) => rollupEntry({ name, conclusion: 'CANCELLED' });
const TIMED_OUT = (name) => rollupEntry({ name, conclusion: 'TIMED_OUT' });
const IN_PROGRESS = (name) => rollupEntry({ name, status: 'IN_PROGRESS' });
const QUEUED = (name) => rollupEntry({ name, status: 'QUEUED' });

// --- Case replays (the bugs that motivated this module) --------------------

test('Case A replay (PR #1960): BLOCKED + failing required check → blocks with merge_state + checks_running=0', () => {
  // Per the screenshot: 1 failing, 1 neutral, 1 cancelled, 4 skipped, 22 successful.
  // GitHub said "Merging is blocked" — mergeStateStatus: BLOCKED.
  const result = classify({
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [
      FAILURE('Run Integration Tests'),
      NEUTRAL('Some Neutral'),
      CANCELLED('Merge Coverage & Report'),
      SKIPPED('Skipped 1'),
      SKIPPED('Skipped 2'),
      SKIPPED('Skipped 3'),
      SKIPPED('Skipped 4'),
      ...Array.from({ length: 22 }, (_, i) => SUCCESS(`OK ${i}`)),
    ],
  });
  assert.equal(result.mergeable, false);
  assert.ok(
    result.blockers.some((b) => b.kind === 'merge_state_blocked'),
    'expected merge_state_blocked blocker'
  );
  // No running checks in Case A; the merge-state blocker is what catches us.
  assert.equal(result.signals.runningCount, 0);
});

test('Case B replay (PR #1929): 9 IN_PROGRESS checks → blocks with checks_running', () => {
  const result = classify({
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [
      ...Array.from({ length: 9 }, (_, i) => IN_PROGRESS(`Check ${i + 1}`)),
      SUCCESS('Already Done 1'),
      NEUTRAL('Already Done 2'),
      SKIPPED('Already Done 3'),
    ],
  });
  assert.equal(result.mergeable, false);
  assert.ok(result.blockers.some((b) => b.kind === 'checks_running'));
  assert.ok(result.blockers.some((b) => b.kind === 'merge_state_blocked'));
  assert.equal(result.signals.runningCount, 9);
});

// --- Per-blocker class -----------------------------------------------------

test('cancelled check on a required path: mergeStateStatus is BLOCKED → blocks via merge_state', () => {
  const result = classify({
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [CANCELLED('Required Check')],
  });
  assert.equal(result.mergeable, false);
  assert.ok(result.blockers.some((b) => b.kind === 'merge_state_blocked'));
});

test('cancelled check on a non-required path: mergeStateStatus UNSTABLE → mergeable (mirror the button)', () => {
  const result = classify({
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [CANCELLED('Optional Lint'), SUCCESS('Required Tests')],
  });
  assert.equal(result.mergeable, true, JSON.stringify(result.blockers));
});

test('CLEAN + neutral + skipped only → mergeable', () => {
  const result = classify({
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [SUCCESS('Tests'), NEUTRAL('Coverage'), SKIPPED('Optional')],
  });
  assert.equal(result.mergeable, true);
  assert.equal(result.blockers.length, 0);
});

test('UNSTABLE with non-required failure → mergeable (mirror the button)', () => {
  const result = classify({
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [SUCCESS('Required'), FAILURE('Optional Lint')],
  });
  assert.equal(result.mergeable, true);
});

test('DIRTY → blocks', () => {
  const result = classify({ mergeStateStatus: 'DIRTY', statusCheckRollup: [SUCCESS('x')] });
  assert.equal(result.mergeable, false);
  assert.ok(result.blockers.some((b) => b.kind === 'merge_state_dirty'));
});

test('BEHIND → blocks', () => {
  const result = classify({ mergeStateStatus: 'BEHIND', statusCheckRollup: [SUCCESS('x')] });
  assert.equal(result.mergeable, false);
  assert.ok(result.blockers.some((b) => b.kind === 'merge_state_behind'));
});

test('UNKNOWN → blocks', () => {
  const result = classify({ mergeStateStatus: 'UNKNOWN', statusCheckRollup: [SUCCESS('x')] });
  assert.equal(result.mergeable, false);
  assert.ok(result.blockers.some((b) => b.kind === 'merge_state_unknown'));
});

test('TIMED_OUT check + BLOCKED merge state → blocks', () => {
  const result = classify({
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [TIMED_OUT('Slow Test')],
  });
  assert.equal(result.mergeable, false);
  assert.ok(result.blockers.some((b) => b.kind === 'merge_state_blocked'));
});

test('QUEUED check counts as running', () => {
  const result = classify({
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [SUCCESS('a'), QUEUED('b')],
  });
  assert.equal(result.mergeable, false);
  assert.equal(result.signals.runningCount, 1);
  assert.ok(result.blockers.some((b) => b.kind === 'checks_running'));
});

test('legacy commit-status with state: PENDING is running', () => {
  const result = classify({
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ context: 'ci/legacy', state: 'PENDING' }],
  });
  assert.equal(result.mergeable, false);
  assert.equal(result.signals.runningCount, 1);
});

test('legacy commit-status with state: SUCCESS is not running', () => {
  const result = classify({
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ context: 'ci/legacy', state: 'SUCCESS' }],
  });
  assert.equal(result.mergeable, true);
});

// --- Empty / odd inputs ----------------------------------------------------

test('empty rollup + CLEAN → mergeable', () => {
  assert.equal(classify({ mergeStateStatus: 'CLEAN', statusCheckRollup: [] }).mergeable, true);
});

test('missing mergeStateStatus → blocks (defaults to UNKNOWN)', () => {
  const result = classify({ statusCheckRollup: [SUCCESS('x')] });
  assert.equal(result.mergeable, false);
  assert.ok(result.blockers.some((b) => b.kind === 'merge_state_unknown'));
});

test('missing statusCheckRollup + CLEAN → mergeable (no running checks)', () => {
  const result = classify({ mergeStateStatus: 'CLEAN' });
  assert.equal(result.mergeable, true);
});

test('exported constant sets match documented behavior', () => {
  assert.ok(MERGEABLE_STATES.has('CLEAN'));
  assert.ok(MERGEABLE_STATES.has('UNSTABLE'));
  assert.equal(MERGEABLE_STATES.has('BLOCKED'), false);
  assert.ok(RUNNING_STATUSES.has('IN_PROGRESS'));
  assert.ok(RUNNING_STATUSES.has('QUEUED'));
});

// --- hasActionableBlockers helper ------------------------------------------

test('hasActionableBlockers: mergeable result → not actionable', () => {
  const r = hasActionableBlockers({ mergeable: true, blockers: [], signals: { prState: 'OPEN' } });
  assert.equal(r.actionable, false);
  assert.deepEqual(r.realBlockers, []);
});

test('hasActionableBlockers: real blocker on OPEN PR → actionable', () => {
  const r = hasActionableBlockers({
    mergeable: false,
    blockers: [{ kind: 'merge_state_dirty' }],
    signals: { prState: 'OPEN' },
  });
  assert.equal(r.actionable, true);
  assert.equal(r.realBlockers.length, 1);
});

test('hasActionableBlockers: only gh_error → not actionable (transient)', () => {
  const r = hasActionableBlockers({
    mergeable: false,
    blockers: [{ kind: 'gh_error', detail: 'timeout' }],
    signals: { prState: 'OPEN' },
  });
  assert.equal(r.actionable, false);
  assert.deepEqual(r.realBlockers, []);
});

test('hasActionableBlockers: gh_error + real blocker → actionable, gh_error filtered', () => {
  const r = hasActionableBlockers({
    mergeable: false,
    blockers: [{ kind: 'gh_error' }, { kind: 'checks_running' }],
    signals: { prState: 'OPEN' },
  });
  assert.equal(r.actionable, true);
  assert.equal(r.realBlockers.length, 1);
  assert.equal(r.realBlockers[0].kind, 'checks_running');
});

test('hasActionableBlockers: MERGED PR with non-mergeable result → not actionable', () => {
  // Transient mergeStateStatus=UNKNOWN window right after merge.
  const r = hasActionableBlockers({
    mergeable: false,
    blockers: [{ kind: 'merge_state_unknown' }],
    signals: { prState: 'MERGED' },
  });
  assert.equal(r.actionable, false);
});

test('hasActionableBlockers: prStateOverride wins over signals.prState', () => {
  // ci-gate fetches prState separately and passes it in.
  const r = hasActionableBlockers(
    {
      mergeable: false,
      blockers: [{ kind: 'merge_state_dirty' }],
      signals: { prState: 'OPEN' },
    },
    { prStateOverride: 'MERGED' }
  );
  assert.equal(r.actionable, false, 'override should suppress action');
});

test('hasActionableBlockers: missing prState defaults to "treat as open"', () => {
  // Preserves historical behaviour for callers/tests that don't populate signals.
  const r = hasActionableBlockers({
    mergeable: false,
    blockers: [{ kind: 'merge_state_dirty' }],
    signals: {},
  });
  assert.equal(r.actionable, true);
});

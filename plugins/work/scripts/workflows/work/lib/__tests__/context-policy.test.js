'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Lazily require the module UNDER TEST inside each test body. During the RED
// phase the source file does not exist yet. A top-level require — or an
// uncaught require inside a test — surfaces the runtime's "Cannot find module"
// / "MODULE_NOT_FOUND" text in the runner output, which the RED gate flags as
// a structural load failure rather than a behavior gap. We catch that specific
// bootstrap error and re-fail with a clean, signature-free assertion message
// so the RED failure reflects the missing behavior (unimplemented exports),
// not a broken test file. Once the source lands (GREEN), the require succeeds
// and the real assertions run.
function policy() {
  try {
    return require('../context-policy');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      assert.fail('context-policy not implemented yet (unimplemented behavior)');
    }
    throw err;
  }
}

// ─── parseThresholds (R2 default 60/70/80, R3 parse-with-fallback) ───────────

test('parseThresholds: "50,90" → [50,90]', () => {
  assert.deepEqual(policy().parseThresholds('50,90'), [50, 90]);
});

test('parseThresholds: sorts ascending and dedupes → "80,60,70,60" → [60,70,80]', () => {
  assert.deepEqual(policy().parseThresholds('80,60,70,60'), [60, 70, 80]);
});

test('parseThresholds: tolerates surrounding whitespace → " 50 , 90 " → [50,90]', () => {
  assert.deepEqual(policy().parseThresholds(' 50 , 90 '), [50, 90]);
});

test('parseThresholds: missing (undefined) → default [60,70,80]', () => {
  assert.deepEqual(policy().parseThresholds(undefined), [60, 70, 80]);
});

test('parseThresholds: null → default [60,70,80]', () => {
  assert.deepEqual(policy().parseThresholds(null), [60, 70, 80]);
});

test('parseThresholds: empty string → default [60,70,80]', () => {
  assert.deepEqual(policy().parseThresholds(''), [60, 70, 80]);
});

test('parseThresholds: "not-a-number" → default [60,70,80]', () => {
  assert.deepEqual(policy().parseThresholds('not-a-number'), [60, 70, 80]);
});

test('parseThresholds: fully invalid list "abc,,xyz" → default [60,70,80]', () => {
  assert.deepEqual(policy().parseThresholds('abc,,xyz'), [60, 70, 80]);
});

test('parseThresholds: DEFAULT_THRESHOLDS constant is [60,70,80]', () => {
  assert.deepEqual(policy().DEFAULT_THRESHOLDS, [60, 70, 80]);
});

test('parseThresholds: returned default is a copy, not a shared mutable reference', () => {
  const first = policy().parseThresholds(undefined);
  first.push(999);
  assert.deepEqual(policy().parseThresholds(undefined), [60, 70, 80]);
});

// ─── modelContextLimit (R8 model→limit map + override) ───────────────────────

test('modelContextLimit: Opus → 200000', () => {
  assert.equal(policy().modelContextLimit('claude-opus-4-8'), 200000);
});

test('modelContextLimit: Sonnet → 200000', () => {
  assert.equal(policy().modelContextLimit('claude-sonnet-4-5'), 200000);
});

test('modelContextLimit: Haiku → 200000', () => {
  assert.equal(policy().modelContextLimit('claude-haiku-4'), 200000);
});

test('modelContextLimit: unknown model → safe default 200000', () => {
  assert.equal(policy().modelContextLimit('some-unknown-model'), 200000);
});

test('modelContextLimit: undefined model → safe default 200000', () => {
  assert.equal(policy().modelContextLimit(undefined), 200000);
});

test('modelContextLimit: integer override honored over the map', () => {
  assert.equal(policy().modelContextLimit('claude-opus-4-8', 500000), 500000);
});

test('modelContextLimit: override honored even for an unknown model', () => {
  assert.equal(policy().modelContextLimit('mystery', 123456), 123456);
});

test('modelContextLimit: invalid (non-numeric) override is ignored, falls back to map', () => {
  assert.equal(policy().modelContextLimit('claude-opus-4-8', 'not-a-number'), 200000);
});

test('modelContextLimit: zero/negative override is ignored, falls back to map', () => {
  assert.equal(policy().modelContextLimit('claude-opus-4-8', 0), 200000);
  assert.equal(policy().modelContextLimit('claude-opus-4-8', -5), 200000);
});

test('modelContextLimit: DEFAULT_CONTEXT_LIMIT constant is 200000', () => {
  assert.equal(policy().DEFAULT_CONTEXT_LIMIT, 200000);
});

// ─── percentUsed (R4 integer floor percent, zero-guard, clamp) ───────────────

test('percentUsed: percentUsed(124000, 200000) → 62 (integer floor)', () => {
  assert.equal(policy().percentUsed(124000, 200000), 62);
});

test('percentUsed: floors rather than rounds → 131000/200000 = 65.5 → 65', () => {
  assert.equal(policy().percentUsed(131000, 200000), 65);
});

test('percentUsed: divide-by-zero guard → limit 0 → 0', () => {
  assert.equal(policy().percentUsed(124000, 0), 0);
});

test('percentUsed: clamps at 100 when usage exceeds the limit', () => {
  assert.equal(policy().percentUsed(250000, 200000), 100);
});

test('percentUsed: exactly at the limit → 100', () => {
  assert.equal(policy().percentUsed(200000, 200000), 100);
});

test('percentUsed: zero usage → 0', () => {
  assert.equal(policy().percentUsed(0, 200000), 0);
});

// ─── newlyCrossed (R2 fire once per crossed threshold) ───────────────────────

test('newlyCrossed: 62% with [60,70,80], none crossed → only [60]', () => {
  assert.deepEqual(policy().newlyCrossed(62, [60, 70, 80], []), [60]);
});

test('newlyCrossed: 62% with 60 already crossed → [] (no repeat)', () => {
  assert.deepEqual(policy().newlyCrossed(62, [60, 70, 80], [60]), []);
});

test('newlyCrossed: 85% with [60,70,80], 60 already crossed → [70,80] ascending', () => {
  assert.deepEqual(policy().newlyCrossed(85, [60, 70, 80], [60]), [70, 80]);
});

test('newlyCrossed: 85% none crossed, unsorted input → [60,70,80] ascending', () => {
  assert.deepEqual(policy().newlyCrossed(85, [80, 60, 70], []), [60, 70, 80]);
});

test('newlyCrossed: threshold equal to percent counts as crossed (<=)', () => {
  assert.deepEqual(policy().newlyCrossed(60, [60, 70, 80], []), [60]);
});

test('newlyCrossed: below the first threshold → []', () => {
  assert.deepEqual(policy().newlyCrossed(55, [60, 70, 80], []), []);
});

test('newlyCrossed: all thresholds already crossed → []', () => {
  assert.deepEqual(policy().newlyCrossed(85, [60, 70, 80], [60, 70, 80]), []);
});

// ─── renderWarning (R4 step+agent+percent, R5 critical recommendation) ───────

function warning(overrides = {}) {
  return policy().renderWarning({
    percent: 62,
    step: 'implement',
    agent: 'developer-nodejs-tdd',
    threshold: 60,
    isCritical: false,
    ...overrides,
  });
}

test('renderWarning: contains the step name', () => {
  assert.match(warning(), /implement/);
});

test('renderWarning: contains the agent/tool name', () => {
  assert.match(warning(), /developer-nodejs-tdd/);
});

test('renderWarning: contains the integer percent as "62%"', () => {
  assert.match(warning(), /62%/);
});

test('renderWarning: non-critical does NOT contain the fresh-agent recommendation', () => {
  assert.doesNotMatch(warning(), /fresh agent/i);
});

test('renderWarning: critical contains a recommendation to commit current work', () => {
  assert.match(warning({ percent: 85, threshold: 80, isCritical: true }), /commit/i);
});

test('renderWarning: critical contains a recommendation to spawn a fresh agent', () => {
  assert.match(warning({ percent: 85, threshold: 80, isCritical: true }), /fresh agent/i);
});

test('renderWarning: critical still names step, agent, and percent', () => {
  const msg = warning({
    percent: 85,
    step: 'commit',
    agent: 'commit-writer',
    threshold: 80,
    isCritical: true,
  });
  assert.match(msg, /commit-writer/);
  assert.match(msg, /85%/);
});

test('renderWarning: returns a non-empty string', () => {
  const msg = warning();
  assert.equal(typeof msg, 'string');
  assert.ok(msg.length > 0);
});

// Pre-existed-regression RED fallback: regression tasks that exercise code
// already implemented in a prior task cannot organically produce a failing
// test command. Authors opt in via two co-occurring markers in the task body
// ("pre-existed" AND "regression test added"), and the RED gate accepts
// exit 0 by forwarding `--synthesized` to tdd-phase-state.js.
//
// Covers:
//   - isPreExistedRegressionTask (marker detection)
//   - evaluatePreExistedRegressionRed (decision branches: missing test files,
//     uncovered scenarios, no test blocks, two advance paths)

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPreExistedRegressionTask,
  evaluatePreExistedRegressionRed,
} = require('../task-next.js');

// ────────────────────────────────────────────────────────────────────────
// isPreExistedRegressionTask — both markers required, casual prose rejected
// ────────────────────────────────────────────────────────────────────────

test('isPreExistedRegressionTask: true when both markers co-occur (British spelling)', () => {
  const section = 'Expected outcome: behaviour pre-existed, regression test added.';
  assert.equal(isPreExistedRegressionTask(section), true);
});

test('isPreExistedRegressionTask: true when both markers co-occur (US spelling)', () => {
  // The matcher does NOT depend on British "behaviour" — only on the two
  // anchor markers `pre-existed` and `regression test added` being present.
  const section = 'Expected outcome: behavior pre-existed; regression test added.';
  assert.equal(isPreExistedRegressionTask(section), true);
});

test('isPreExistedRegressionTask: false for "pre-existed" alone (no regression-test claim)', () => {
  const section = 'Helper pre-existed elsewhere in the module and is reused here.';
  assert.equal(isPreExistedRegressionTask(section), false);
});

test('isPreExistedRegressionTask: false for "regression test added" alone (no pre-existed claim)', () => {
  // Reviewer issue 3: the bare phrase used to match incidental prose like
  // "The regression test added here covers the new branch." This must now
  // require the `pre-existed` marker to also be present.
  const section = 'The regression test added here covers the new branch.';
  assert.equal(isPreExistedRegressionTask(section), false);
});

test('isPreExistedRegressionTask: false for US spelling without "regression test added"', () => {
  const section = 'Expected outcome: behavior pre-existed.';
  assert.equal(isPreExistedRegressionTask(section), false);
});

test('isPreExistedRegressionTask: tolerates hyphenated and non-hyphenated forms', () => {
  assert.equal(
    isPreExistedRegressionTask('behaviour pre-existed; regression test added'),
    true
  );
  assert.equal(
    isPreExistedRegressionTask('behaviour preexisted, regression test added'),
    true
  );
});

test('isPreExistedRegressionTask: false for a normal RED task body', () => {
  const section =
    '### Type\nbackend\n\nWrite a failing test for the new resolver, then implement.';
  assert.equal(isPreExistedRegressionTask(section), false);
});

test('isPreExistedRegressionTask: tolerates missing/empty/non-string inputs', () => {
  assert.equal(isPreExistedRegressionTask(''), false);
  assert.equal(isPreExistedRegressionTask(undefined), false);
  assert.equal(isPreExistedRegressionTask(null), false);
  assert.equal(isPreExistedRegressionTask(42), false);
});

test('isPreExistedRegressionTask: case-insensitive on both markers', () => {
  assert.equal(
    isPreExistedRegressionTask('BEHAVIOUR PRE-EXISTED, REGRESSION TEST ADDED'),
    true
  );
});

// ────────────────────────────────────────────────────────────────────────
// evaluatePreExistedRegressionRed — pure decision function
// (one test per branch; no subprocess machinery required)
// ────────────────────────────────────────────────────────────────────────

const TMP_ROOT = path.join(os.tmpdir(), `pre-existed-regression-test-${process.pid}`);

test.before(() => fs.mkdirSync(TMP_ROOT, { recursive: true }));
test.after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

function writeTestFile(name, body) {
  const full = path.join(TMP_ROOT, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

test('evaluatePreExistedRegressionRed: BLOCK when no test files in scope', () => {
  const result = evaluatePreExistedRegressionRed({
    scenarios: [{ name: 'Some scenario' }],
    testFiles: [],
    totalBlocks: 0,
    taskNum: 3,
  });
  assert.equal(result.verdict, 'block');
  assert.match(result.reason, /no test files found under Suggested Scope/);
});

test('evaluatePreExistedRegressionRed: BLOCK when scenarios are not covered by test titles', () => {
  const filePath = writeTestFile(
    `uncovered-${Date.now()}.test.js`,
    "it('some other test title', () => {});\n"
  );
  const result = evaluatePreExistedRegressionRed({
    scenarios: [{ name: 'GREP with /s flag matches across newlines' }],
    testFiles: [filePath],
    totalBlocks: 1,
    taskNum: 3,
  });
  assert.equal(result.verdict, 'block');
  assert.match(result.reason, /do not yet cover these scenarios/);
  assert.match(result.reason, /GREP with \/s flag matches across newlines/);
});

test('evaluatePreExistedRegressionRed: ADVANCE when scenarios are covered by test titles', () => {
  const filePath = writeTestFile(
    `covered-${Date.now()}.test.js`,
    "it('GREP with /s flag matches across newlines (G-S5)', () => {});\n"
  );
  const result = evaluatePreExistedRegressionRed({
    scenarios: [{ name: 'GREP with /s flag matches across newlines' }],
    testFiles: [filePath],
    totalBlocks: 1,
    taskNum: 3,
  });
  assert.equal(result.verdict, 'advance');
  assert.match(result.label, /1 scenario\(s\) covered/);
});

test('evaluatePreExistedRegressionRed: BLOCK when no gherkin tags and no test blocks in scope', () => {
  const filePath = writeTestFile(
    `empty-${Date.now()}.test.js`,
    "// no it()/test() blocks yet\n"
  );
  const result = evaluatePreExistedRegressionRed({
    scenarios: [],
    testFiles: [filePath],
    totalBlocks: 0,
    taskNum: 3,
  });
  assert.equal(result.verdict, 'block');
  assert.match(result.reason, /no it\(\)\/test\(\) blocks found/);
});

test('evaluatePreExistedRegressionRed: ADVANCE via unit-only fallback (no gherkin tags, test blocks present)', () => {
  const filePath = writeTestFile(
    `units-${Date.now()}.test.js`,
    "it('unit test a', () => {});\nit('unit test b', () => {});\n"
  );
  const result = evaluatePreExistedRegressionRed({
    scenarios: [],
    testFiles: [filePath],
    totalBlocks: 2,
    taskNum: 7,
  });
  assert.equal(result.verdict, 'advance');
  assert.match(result.label, /no @task:7 gherkin tags/);
  assert.match(result.label, /2 test block\(s\)/);
});

test('evaluatePreExistedRegressionRed: BLOCK on undefined/null testFiles input', () => {
  const result = evaluatePreExistedRegressionRed({
    scenarios: [],
    testFiles: undefined,
    totalBlocks: 0,
    taskNum: 3,
  });
  assert.equal(result.verdict, 'block');
  assert.match(result.reason, /no test files found/);
});

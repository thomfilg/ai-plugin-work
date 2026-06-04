const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { CHECK_GATE_RULES, validateCheckGate } = require('../gates/check-gate');

const TEMP = path.join(os.tmpdir(), 'check-gate-test-' + process.pid);
let testTicket;
let testCount = 0;

function writeReport(name, content) {
  const dir = path.join(TEMP, testTicket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));
beforeEach(() => {
  testTicket = `T-${++testCount}`;
});

// R3: describe-level WEB_APPS isolation. Saves any ambient WEB_APPS into a
// closure, deletes it from the env before each test, busts the require.cache
// entries for ../../lib/config and ../gates/check-gate so they re-read the
// (now-clean) env on next require(), and on teardown restores the original
// value with an `=== undefined` check so an explicit empty-string is preserved.
function installWebAppsIsolation() {
  let savedWebApps;
  const configPath = require.resolve('../../lib/config');
  const gatePath = require.resolve('../gates/check-gate');
  beforeEach(() => {
    savedWebApps = process.env.WEB_APPS;
    delete process.env.WEB_APPS;
    delete require.cache[configPath];
    delete require.cache[gatePath];
  });
  afterEach(() => {
    if (savedWebApps === undefined) delete process.env.WEB_APPS;
    else process.env.WEB_APPS = savedWebApps;
    delete require.cache[configPath];
    delete require.cache[gatePath];
  });
}

describe('check-gate (unit)', () => {
  installWebAppsIsolation();

  // Meta-test (R3): every test in this describe must observe an isolated
  // baseline regardless of the parent shell's WEB_APPS.
  it('observes WEB_APPS=undefined at test start regardless of ambient env', () => {
    assert.equal(
      process.env.WEB_APPS,
      undefined,
      'WEB_APPS must be deleted by describe-level beforeEach before each test runs'
    );
  });

  it('CHECK_GATE_RULES has 5 rules with required shape', () => {
    assert.equal(CHECK_GATE_RULES.length, 5);
    for (const rule of CHECK_GATE_RULES) {
      assert.ok(rule.name, 'rule must have a name');
      assert.ok(rule.description, 'rule must have a description');
      assert.equal(typeof rule.check, 'function', 'rule must have a check function');
    }
  });

  it('validateCheckGate returns valid when all reports pass', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport('qa-feature.check.md', 'Status: APPROVED');
    const result = validateCheckGate(TEMP, testTicket);
    assert.equal(result.valid, true);
    assert.equal(result.reasons.length, 0);
  });

  it('validateCheckGate returns reasons for missing reports', () => {
    const result = validateCheckGate(TEMP, testTicket);
    assert.equal(result.valid, false);
    assert.ok(result.reasons.length >= 3);
    assert.ok(result.reasons.some((r) => r.includes('tests.check.md')));
  });

  it('required-reports rule detects bad status', () => {
    writeReport('tests.check.md', 'Status: FAILED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: APPROVED');
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('tests.check.md'));
  });

  it('qa-reports rule requires at least one when WEB_APPS is configured', () => {
    process.env.WEB_APPS = '[{"name":"test-app","defaultPort":3000,"type":"vite"}]';
    delete require.cache[require.resolve('../../lib/config')];
    delete require.cache[require.resolve('../gates/check-gate')];
    const { CHECK_GATE_RULES: freshRules } = require('../gates/check-gate');
    const rule = freshRules.find((r) => r.name === 'qa-reports');
    fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].toLowerCase().includes('qa'));
  });

  it('qa-reports rule detects unapproved QA file when WEB_APPS is configured', () => {
    process.env.WEB_APPS = '[{"name":"test-app","defaultPort":3000,"type":"vite"}]';
    delete require.cache[require.resolve('../../lib/config')];
    delete require.cache[require.resolve('../gates/check-gate')];
    const { CHECK_GATE_RULES: freshRules } = require('../gates/check-gate');
    writeReport('qa-feature.check.md', 'Status: FAILED');
    const rule = freshRules.find((r) => r.name === 'qa-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('qa-feature.check.md'), 'reason should mention file');
    assert.ok(
      reasons[0].includes('APPROVED or NOT_APPLICABLE'),
      'reason should mention accepted statuses'
    );
  });

  it('running-agents rule returns empty when no tmux sessions', () => {
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'running-agents');
    const reasons = rule.check(path.join(TEMP, testTicket), testTicket);
    assert.equal(reasons.length, 0);
  });

  it('spec-verification rule fails when spec has failing checks (scenario 11)', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport('qa-feature.check.md', 'Status: APPROVED');
    const ticketDir = path.join(TEMP, testTicket);
    const { execFileSync: exec } = require('child_process');
    exec('git', ['init'], { cwd: ticketDir, stdio: 'pipe' });
    fs.writeFileSync(
      path.join(ticketDir, 'spec.md'),
      '# Spec\n\n## Verification Checklist\n- FILE_EXISTS src/nonexistent-file.js\n'
    );
    const result = validateCheckGate(TEMP, testTicket);
    assert.equal(result.valid, false);
    assert.ok(
      result.reasons.some(
        (r) =>
          r.includes('Spec verification failed') &&
          r.includes('FILE_EXISTS') &&
          r.includes('nonexistent-file.js')
      )
    );
  });

  // ─── GH-181: qa-reports rule skips when WEB_APPS is empty ───────────────

  it('qa-reports rule passes (returns []) when WEB_APPS is empty', () => {
    process.env.WEB_APPS = '[]';
    // Re-require to pick up env change — config caches WEB_APPS at load time
    // so we need to invalidate the config cache
    delete require.cache[require.resolve('../../lib/config')];
    delete require.cache[require.resolve('../gates/check-gate')];
    const { CHECK_GATE_RULES: freshRules } = require('../gates/check-gate');
    const rule = freshRules.find((r) => r.name === 'qa-reports');
    fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.deepStrictEqual(reasons, [], 'qa-reports should pass when WEB_APPS is empty');
  });

  it('qa-reports rule passes when WEB_APPS env is unset', () => {
    // WEB_APPS already deleted by describe-level beforeEach
    const { CHECK_GATE_RULES: freshRules } = require('../gates/check-gate');
    const rule = freshRules.find((r) => r.name === 'qa-reports');
    fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.deepStrictEqual(reasons, [], 'qa-reports should pass when WEB_APPS is unset');
  });

  it('qa-reports rule still requires QA reports when WEB_APPS has entries', () => {
    process.env.WEB_APPS = '[{"name":"my-app","defaultPort":3000,"type":"vite"}]';
    delete require.cache[require.resolve('../../lib/config')];
    delete require.cache[require.resolve('../gates/check-gate')];
    const { CHECK_GATE_RULES: freshRules } = require('../gates/check-gate');
    const rule = freshRules.find((r) => r.name === 'qa-reports');
    fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.equal(
      reasons.length,
      1,
      'qa-reports should still require QA when WEB_APPS has entries'
    );
    assert.ok(reasons[0].toLowerCase().includes('qa'));
  });

  it('validateCheckGate passes with required reports and no QA when WEB_APPS empty', () => {
    process.env.WEB_APPS = '[]';
    delete require.cache[require.resolve('../../lib/config')];
    delete require.cache[require.resolve('../gates/check-gate')];
    const { validateCheckGate: freshValidate } = require('../gates/check-gate');
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    // No qa-*.check.md files — should still pass
    const result = freshValidate(TEMP, testTicket);
    // Filter out running-agents and spec-verification failures (tmux/git dependent)
    const qaReasons = result.reasons.filter((r) => r.toLowerCase().includes('qa'));
    assert.deepStrictEqual(
      qaReasons,
      [],
      'should have no QA-related failures when WEB_APPS is empty'
    );
  });

  // ─── GH-259: per-task TDD evidence gate ──────────────────────────────────

  function writeTaskFile(taskDir, name, content) {
    const dir = path.join(TEMP, testTicket, taskDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }

  it('per-task-tdd-evidence rule passes when tasks.md exists and all tasks have TDD evidence', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n## Task 2\n');
    writeTaskFile(
      'task1',
      'tdd-phase.json',
      JSON.stringify({
        cycles: [{ red: { ts: 1 }, green: { ts: 2 } }],
      })
    );
    writeTaskFile(
      'task2',
      'tdd-phase.json',
      JSON.stringify({
        cycles: [{ red: { ts: 1 }, green: { ts: 2 } }],
      })
    );
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    assert.ok(rule, 'per-task-tdd-evidence rule must exist');
    const reasons = rule.check(dir, testTicket);
    assert.deepStrictEqual(reasons, []);
  });

  it('per-task-tdd-evidence rule fails when a task dir is missing tdd-phase.json', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n## Task 2\n');
    writeTaskFile(
      'task1',
      'tdd-phase.json',
      JSON.stringify({
        cycles: [{ red: { ts: 1 }, green: { ts: 2 } }],
      })
    );
    // task2 exists but no tdd-phase.json
    fs.mkdirSync(path.join(dir, 'task2'), { recursive: true });
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(dir, testTicket);
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('task2'));
    assert.ok(reasons[0].toLowerCase().includes('tdd'));
  });

  it('per-task-tdd-evidence rule fails when tdd-phase.json has no complete cycle', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n');
    writeTaskFile(
      'task1',
      'tdd-phase.json',
      JSON.stringify({
        cycles: [{ red: { ts: 1 } }], // no green
      })
    );
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(dir, testTicket);
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('task1'));
    assert.ok(reasons[0].includes('RED'));
  });

  it('per-task-tdd-evidence rule passes when tdd-phase.json has exception mode', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n');
    writeTaskFile(
      'task1',
      'tdd-phase.json',
      JSON.stringify({
        exception: 'config-only change',
        cycles: [],
      })
    );
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(dir, testTicket);
    assert.deepStrictEqual(reasons, []);
  });

  it('per-task-tdd-evidence rule skips when no tasks.md (single-task mode)', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    // No tasks.md
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(dir, testTicket);
    assert.deepStrictEqual(reasons, []);
  });

  it('per-task-tdd-evidence rule fails when tdd-phase.json is invalid JSON', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n');
    writeTaskFile('task1', 'tdd-phase.json', 'not valid json{{{');
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(dir, testTicket);
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('task1'));
    assert.ok(reasons[0].toLowerCase().includes('json'));
  });

  it('per-task-tdd-evidence rule fails when tasks.md declares tasks but no taskN dirs exist', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n');
    // No task directories created yet — gate must catch this
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(dir, testTicket);
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('task1'));
    assert.ok(reasons[0].toLowerCase().includes('tdd'));
  });

  it('per-task-tdd-evidence rule fails when tasks.md declares 3 tasks but only 2 dirs exist', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n## Task 2\n## Task 3\n');
    writeTaskFile(
      'task1',
      'tdd-phase.json',
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );
    writeTaskFile(
      'task2',
      'tdd-phase.json',
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );
    // task3 directory does not exist at all
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(dir, testTicket);
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('task3'));
    assert.ok(reasons[0].toLowerCase().includes('tdd'));
  });

  it('per-task-tdd-evidence rule skips checkpoint tasks from tasks.md', () => {
    const dir = path.join(TEMP, testTicket);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'tasks.md'),
      '# Tasks\n\n## Task 1\n— Implement feature\n### Type\nimplementation\n\n## Task 2\n— Checkpoint\n### Type\ncheckpoint\n'
    );
    writeTaskFile(
      'task1',
      'tdd-phase.json',
      JSON.stringify({ cycles: [{ red: { ts: 1 }, green: { ts: 2 } }] })
    );
    // task2 is a checkpoint — no dir needed
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'per-task-tdd-evidence');
    const reasons = rule.check(dir, testTicket);
    assert.deepStrictEqual(reasons, []);
  });

  it('validateCheckGate multi-task: passes when all reports + TDD evidence present', () => {
    const dir = path.join(TEMP, testTicket);
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n## Task 2\n');
    writeTaskFile(
      'task1',
      'tdd-phase.json',
      JSON.stringify({
        cycles: [{ red: { ts: 1 }, green: { ts: 2 } }],
      })
    );
    writeTaskFile(
      'task2',
      'tdd-phase.json',
      JSON.stringify({
        cycles: [{ red: { ts: 1 }, green: { ts: 2 } }],
      })
    );
    const result = validateCheckGate(TEMP, testTicket);
    // Filter out running-agents and spec-verification (env-dependent)
    const tddReasons = result.reasons.filter((r) => r.toLowerCase().includes('tdd'));
    assert.deepStrictEqual(tddReasons, []);
  });

  it('validateCheckGate multi-task: fails when task2 missing TDD evidence', () => {
    const dir = path.join(TEMP, testTicket);
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    fs.writeFileSync(path.join(dir, 'tasks.md'), '# Tasks\n\n## Task 1\n## Task 2\n');
    writeTaskFile(
      'task1',
      'tdd-phase.json',
      JSON.stringify({
        cycles: [{ red: { ts: 1 }, green: { ts: 2 } }],
      })
    );
    fs.mkdirSync(path.join(dir, 'task2'), { recursive: true });
    // task2 has no tdd-phase.json
    const result = validateCheckGate(TEMP, testTicket);
    assert.equal(result.valid, false);
    assert.ok(result.reasons.some((r) => r.includes('task2') && r.toLowerCase().includes('tdd')));
  });

  it('spec-verification rule passes when spec has no checklist (scenario 12)', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport('qa-feature.check.md', 'Status: APPROVED');
    const ticketDir = path.join(TEMP, testTicket);
    fs.writeFileSync(
      path.join(ticketDir, 'spec.md'),
      '# Spec\n\n## Summary\nLegacy spec without verification checklist\n'
    );
    const result = validateCheckGate(TEMP, testTicket);
    assert.equal(result.valid, true);
    const specRule = CHECK_GATE_RULES.find((r) => r.name === 'spec-verification');
    const reasons = specRule.check(ticketDir, testTicket);
    assert.equal(reasons.length, 0);
  });

  // ─── GH-232: code-review reply reconciliation ──────────────────────────

  it('required-reports rule passes when code-review has complete reply file', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    // code-review has CRITICAL issues (would normally fail)
    writeReport(
      'code-review.check.md',
      '# Code Review\n\n## CRITICAL ISSUES\n\n**Missing error handling**\n\nStatus: NEEDS_WORK'
    );
    // But the reply file resolves all issues
    writeReport(
      'code-review-reply.check.md',
      '## Issue: Missing error handling\n\n**Decision:** FIXED\n**Reason:** Added try/catch blocks\n'
    );
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.deepStrictEqual(reasons, [], 'code-review with complete reply should pass');
  });

  it('required-reports rule blocks when code-review reply is incomplete', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport(
      'code-review.check.md',
      '# Code Review\n\n## CRITICAL ISSUES\n\n**Missing error handling**\n\n**SQL injection risk**\n\nStatus: NEEDS_WORK'
    );
    // Reply only addresses one of two issues
    writeReport(
      'code-review-reply.check.md',
      '## Issue: Missing error handling\n\n**Decision:** FIXED\n**Reason:** Added try/catch blocks\n'
    );
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.ok(reasons.length > 0, 'incomplete reply should block');
    assert.ok(
      reasons.some((r) => r.includes('code-review')),
      'reason should mention code-review'
    );
  });

  it('required-reports rule blocks when no reply file and CRITICAL issues present', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport(
      'code-review.check.md',
      '# Code Review\n\n## CRITICAL ISSUES\n\n**Missing error handling**\n\nStatus: NEEDS_WORK'
    );
    // No reply file exists
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.ok(reasons.length > 0, 'no reply with CRITICAL issues should block');
    assert.ok(reasons.some((r) => r.includes('code-review')));
  });

  it('required-reports rule passes APPROVED code-review even with incomplete reply file', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    // code-review is APPROVED — reply should not block it
    writeReport('code-review.check.md', 'Status: APPROVED\n\n## CRITICAL ISSUES\nNone found.');
    // Incomplete reply file exists
    writeReport(
      'code-review-reply.check.md',
      '## Issue: Some other issue\n\n**Decision:** FIXED\n**Reason:** Done\n'
    );
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.deepStrictEqual(
      reasons,
      [],
      'APPROVED code-review should pass regardless of reply state'
    );
  });

  it('required-reports rule blocks empty code-review even with reply file', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport('code-review.check.md', '   '); // empty/whitespace
    writeReport(
      'code-review-reply.check.md',
      '## Issue: X\n**Decision:** FIXED\n**Reason:** Done\n'
    );
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.ok(reasons.length > 0, 'empty code-review must not pass');
    assert.ok(reasons[0].includes('empty'), 'reason should mention empty');
  });

  it('required-reports rule passes with bold Status format', () => {
    writeReport('tests.check.md', '**Status:** **APPROVED**');
    writeReport('code-review.check.md', '**Status:** **APPROVED**');
    writeReport('completion.check.md', '**Status:** **COMPLETE**');
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.deepStrictEqual(reasons, [], 'bold Status format should be recognized');
  });

  it('required-reports rule passes with summary table format', () => {
    writeReport('tests.check.md', '| Status | APPROVED |');
    writeReport('code-review.check.md', '| Status | APPROVED |');
    writeReport('completion.check.md', '| Status | COMPLETE |');
    const rule = CHECK_GATE_RULES.find((r) => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.deepStrictEqual(reasons, [], 'summary table format should be recognized');
  });

  // ─── GH-232: QA NOT_APPLICABLE ─────────────────────────────────────────

  it('qa-reports rule passes when report has Status: NOT_APPLICABLE', () => {
    process.env.WEB_APPS = '[{"name":"test-app","defaultPort":3000,"type":"vite"}]';
    delete require.cache[require.resolve('../../lib/config')];
    delete require.cache[require.resolve('../gates/check-gate')];
    const { CHECK_GATE_RULES: freshRules } = require('../gates/check-gate');
    writeReport(
      'qa-feature.check.md',
      'QA skipped because no WEB_APPS configured\n\nStatus: NOT_APPLICABLE'
    );
    const rule = freshRules.find((r) => r.name === 'qa-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.deepStrictEqual(reasons, [], 'NOT_APPLICABLE QA report should pass');
  });

  // ─── GH-232: structured per-rule results ────────────────────────────────

  it('validateCheckGate returns structured rules array', () => {
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    const result = validateCheckGate(TEMP, testTicket);
    // Result must have rules array
    assert.ok(Array.isArray(result.rules), 'result must have rules array');
    assert.equal(
      result.rules.length,
      CHECK_GATE_RULES.length,
      'rules array must have one entry per gate rule'
    );
    for (const rule of result.rules) {
      assert.ok(typeof rule.name === 'string', 'each rule must have a name');
      assert.ok(typeof rule.passed === 'boolean', 'each rule must have a passed boolean');
      assert.ok(Array.isArray(rule.reasons), 'each rule must have a reasons array');
    }
    // Backward compatibility: valid and reasons still present
    assert.ok(typeof result.valid === 'boolean', 'valid must still exist');
    assert.ok(Array.isArray(result.reasons), 'reasons must still exist');
  });

  // ─── GH-232 Task 8: False-negative scenario integration tests ───────────
  // These exercise the full validateCheckGate() path, not individual rules.

  it('integration: code-review with reply resolution passes full gate', () => {
    // Scenario: code-review.check.md has CRITICAL issues but
    // code-review-reply.check.md resolves all of them.
    // The full validateCheckGate() must return valid: true.
    // WEB_APPS is unset by the describe-level beforeEach so qa-reports rule
    // does not require any QA file — isolated from a polluted parent env.
    const { validateCheckGate: freshValidate } = require('../gates/check-gate');
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport(
      'code-review.check.md',
      '# Code Review\n\n## CRITICAL ISSUES\n\n**Unsafe input handling**\n\n**Memory leak in event listener**\n\nStatus: NEEDS_WORK'
    );
    writeReport(
      'code-review-reply.check.md',
      '## Issue: Unsafe input handling\n\n**Decision:** FIXED\n**Reason:** Added input validation\n\n## Issue: Memory leak in event listener\n\n**Decision:** FIXED\n**Reason:** Added cleanup in dispose()\n'
    );
    const result = freshValidate(TEMP, testTicket);
    // Filter to only required-reports and qa-reports reasons (ignore running-agents, spec-verification, tdd which are env-dependent)
    const reportReasons = result.reasons.filter(
      (r) => r.includes('report') || r.includes('Report') || r.includes('code-review')
    );
    assert.deepStrictEqual(
      reportReasons,
      [],
      'gate should pass for code-review when reply resolves all CRITICAL issues'
    );
    // Verify the required-reports rule specifically passed
    const requiredRule = result.rules.find((r) => r.name === 'required-reports');
    assert.ok(requiredRule, 'required-reports rule must be in results');
    assert.equal(requiredRule.passed, true, 'required-reports rule must pass');
    assert.deepStrictEqual(requiredRule.reasons, []);
  });

  it('integration: QA skipped with NOT_APPLICABLE passes full gate', () => {
    // Scenario: WEB_APPS is configured with entries, but the QA report
    // has Status: NOT_APPLICABLE. The full gate must pass.
    process.env.WEB_APPS = '[{"name":"my-app","defaultPort":3000,"type":"vite"}]';
    delete require.cache[require.resolve('../../lib/config')];
    delete require.cache[require.resolve('../gates/check-gate')];
    const { validateCheckGate: freshValidate } = require('../gates/check-gate');
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport(
      'qa-feature.check.md',
      'QA skipped because no WEB_APPS configured\n\nStatus: NOT_APPLICABLE'
    );
    const result = freshValidate(TEMP, testTicket);
    // No QA-related failures
    const qaReasons = result.reasons.filter((r) => r.toLowerCase().includes('qa'));
    assert.deepStrictEqual(
      qaReasons,
      [],
      'gate should pass when QA report has NOT_APPLICABLE status'
    );
    // Verify the qa-reports rule specifically passed
    const qaRule = result.rules.find((r) => r.name === 'qa-reports');
    assert.ok(qaRule, 'qa-reports rule must be in results');
    assert.equal(qaRule.passed, true, 'qa-reports rule must pass with NOT_APPLICABLE');
  });

  it('integration: report with summary table (no Status line) passes full gate', () => {
    // Scenario: tests.check.md has ONLY a summary table format
    // "| Status | APPROVED |" with no explicit "Status: APPROVED" line.
    // The full validateCheckGate() must pass the required-reports rule.
    writeReport(
      'tests.check.md',
      '# Test Results\n\n| Field | Value |\n|-------|-------|\n| Status | APPROVED |\n| Tests | 42 |'
    );
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    const result = validateCheckGate(TEMP, testTicket);
    // Verify required-reports rule passes (tests.check.md recognized via table)
    const requiredRule = result.rules.find((r) => r.name === 'required-reports');
    assert.ok(requiredRule, 'required-reports rule must be in results');
    assert.deepStrictEqual(
      requiredRule.reasons,
      [],
      'required-reports must pass when tests.check.md uses summary table format'
    );
    assert.equal(requiredRule.passed, true);
  });

  it('integration: APPROVED code-review with CRITICAL ISSUES header (no reply file) passes gate (GH-232)', () => {
    // Scenario: code-review.check.md has Status: APPROVED with standard
    // template headers like "### CRITICAL ISSUES\nNone found." but no reply file.
    // The CRITICAL in the section header must NOT trigger a false-negative.
    writeReport('tests.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: COMPLETE');
    writeReport(
      'code-review.check.md',
      [
        '# Code Review Report',
        '',
        'Status: APPROVED',
        '',
        '## Summary',
        'Code looks good overall.',
        '',
        '### CRITICAL ISSUES',
        'None found.',
        '',
        '### IMPORTANT ISSUES',
        'None found.',
        '',
        '### 🟢 NICE-TO-HAVE',
        '**Consider adding JSDoc** for public API.',
      ].join('\n')
    );
    // No reply file — should still pass because report is APPROVED
    const result = validateCheckGate(TEMP, testTicket);
    const requiredRule = result.rules.find((r) => r.name === 'required-reports');
    assert.ok(requiredRule, 'required-reports rule must be in results');
    assert.equal(
      requiredRule.passed,
      true,
      'required-reports must pass when code-review is APPROVED with CRITICAL section headers'
    );
    assert.deepStrictEqual(requiredRule.reasons, []);
  });

  it('integration: validateCheckGate structured rules have name, passed, reasons per rule', () => {
    // Scenario: Call validateCheckGate() with some reports missing to
    // exercise both passing and failing rules. Verify every rule entry
    // has the correct shape AND that the rules array reflects actual pass/fail.
    writeReport('tests.check.md', 'Status: APPROVED');
    // Missing code-review and completion — required-reports should fail
    const result = validateCheckGate(TEMP, testTicket);
    // Shape validation
    assert.ok(Array.isArray(result.rules), 'result must have rules array');
    assert.equal(
      result.rules.length,
      CHECK_GATE_RULES.length,
      'rules array must have one entry per CHECK_GATE_RULE'
    );
    for (const rule of result.rules) {
      assert.ok(
        typeof rule.name === 'string' && rule.name.length > 0,
        `rule must have a non-empty name`
      );
      assert.ok(typeof rule.passed === 'boolean', `rule "${rule.name}" must have a passed boolean`);
      assert.ok(Array.isArray(rule.reasons), `rule "${rule.name}" must have a reasons array`);
      // passed must be consistent with reasons
      if (rule.passed) {
        assert.equal(
          rule.reasons.length,
          0,
          `rule "${rule.name}" marked passed must have empty reasons`
        );
      } else {
        assert.ok(
          rule.reasons.length > 0,
          `rule "${rule.name}" marked failed must have non-empty reasons`
        );
      }
    }
    // required-reports specifically should fail (missing code-review and completion)
    const requiredRule = result.rules.find((r) => r.name === 'required-reports');
    assert.ok(requiredRule, 'required-reports rule must exist');
    assert.equal(requiredRule.passed, false, 'required-reports must fail with missing reports');
    assert.ok(
      requiredRule.reasons.some((r) => r.includes('code-review.check.md')),
      'reasons must mention missing code-review'
    );
    assert.ok(
      requiredRule.reasons.some((r) => r.includes('completion.check.md')),
      'reasons must mention missing completion'
    );
    // Backward compat: top-level valid and reasons
    assert.equal(result.valid, false);
    assert.ok(result.reasons.length > 0);
  });
});

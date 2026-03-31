const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { CHECK_GATE_RULES, validateCheckGate } = require('../check-gate');

const TEMP = path.join(os.tmpdir(), 'check-gate-test-' + process.pid);
let testTicket;
let testCount = 0;

function writeReport(name, content) {
  const dir = path.join(TEMP, testTicket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));
beforeEach(() => { testTicket = `T-${++testCount}`; });

describe('check-gate (unit)', () => {

  it('CHECK_GATE_RULES has 3 rules with required shape', () => {
    assert.equal(CHECK_GATE_RULES.length, 3);
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
    assert.ok(result.reasons.some(r => r.includes('tests.check.md')));
  });

  it('required-reports rule detects bad status', () => {
    writeReport('tests.check.md', 'Status: FAILED');
    writeReport('code-review.check.md', 'Status: APPROVED');
    writeReport('completion.check.md', 'Status: APPROVED');
    const rule = CHECK_GATE_RULES.find(r => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('tests.check.md'));
  });

  it('qa-reports rule requires at least one', () => {
    const rule = CHECK_GATE_RULES.find(r => r.name === 'qa-reports');
    fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].toLowerCase().includes('qa'));
  });

  it('qa-reports rule detects unapproved QA file', () => {
    writeReport('qa-feature.check.md', 'Status: FAILED');
    const rule = CHECK_GATE_RULES.find(r => r.name === 'qa-reports');
    const reasons = rule.check(path.join(TEMP, testTicket));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('qa-feature.check.md'));
  });

  it('running-agents rule returns empty when no tmux sessions', () => {
    const rule = CHECK_GATE_RULES.find(r => r.name === 'running-agents');
    const reasons = rule.check(path.join(TEMP, testTicket), testTicket);
    assert.equal(reasons.length, 0);
  });
});

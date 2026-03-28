const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { CHECK_GATE_RULES, validateCheckGate } = require('../check-gate');

const TEMP = path.join(os.tmpdir(), 'check-gate-test-' + process.pid);

function writeReport(ticket, name, content) {
  const dir = path.join(TEMP, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

// Cleanup: afterEach removes per-ticket dir, after removes the temp root
after(() => { try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch {} });
afterEach(() => { try { fs.rmSync(path.join(TEMP, 'T-1'), { recursive: true, force: true }); } catch {} });

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
    writeReport('T-1', 'tests.check.md', 'Status: APPROVED');
    writeReport('T-1', 'code-review.check.md', 'Status: APPROVED');
    writeReport('T-1', 'completion.check.md', 'Status: COMPLETE');
    writeReport('T-1', 'qa-feature.check.md', 'Status: APPROVED');
    const result = validateCheckGate(TEMP, 'T-1');
    assert.equal(result.valid, true);
    assert.equal(result.reasons.length, 0);
  });

  it('validateCheckGate returns reasons for missing reports', () => {
    // No reports written
    const result = validateCheckGate(TEMP, 'T-1');
    assert.equal(result.valid, false);
    assert.ok(result.reasons.length >= 3);
    assert.ok(result.reasons.some(r => r.includes('tests.check.md')));
  });

  it('required-reports rule detects bad status', () => {
    writeReport('T-1', 'tests.check.md', 'Status: FAILED');
    writeReport('T-1', 'code-review.check.md', 'Status: APPROVED');
    writeReport('T-1', 'completion.check.md', 'Status: APPROVED');
    const rule = CHECK_GATE_RULES.find(r => r.name === 'required-reports');
    const reasons = rule.check(path.join(TEMP, 'T-1'));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('tests.check.md'));
  });

  it('qa-reports rule requires at least one', () => {
    const rule = CHECK_GATE_RULES.find(r => r.name === 'qa-reports');
    fs.mkdirSync(path.join(TEMP, 'T-1'), { recursive: true });
    const reasons = rule.check(path.join(TEMP, 'T-1'));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].toLowerCase().includes('qa'));
  });

  it('qa-reports rule detects unapproved QA file', () => {
    writeReport('T-1', 'qa-feature.check.md', 'Status: FAILED');
    const rule = CHECK_GATE_RULES.find(r => r.name === 'qa-reports');
    const reasons = rule.check(path.join(TEMP, 'T-1'));
    assert.equal(reasons.length, 1);
    assert.ok(reasons[0].includes('qa-feature.check.md'));
  });

  it('running-agents rule returns empty when no tmux sessions', () => {
    const rule = CHECK_GATE_RULES.find(r => r.name === 'running-agents');
    const reasons = rule.check(path.join(TEMP, 'T-1'), 'T-1');
    assert.equal(reasons.length, 0);
  });
});

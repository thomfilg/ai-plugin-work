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
beforeEach(() => {
  testTicket = `T-${++testCount}`;
});

describe('check-gate (unit)', () => {
  it('CHECK_GATE_RULES has 4 rules with required shape', () => {
    assert.equal(CHECK_GATE_RULES.length, 4);
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
    const savedWebApps = process.env.WEB_APPS;
    try {
      process.env.WEB_APPS = '[{"name":"test-app","defaultPort":3000,"type":"vite"}]';
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
      const { CHECK_GATE_RULES: freshRules } = require('../check-gate');
      const rule = freshRules.find((r) => r.name === 'qa-reports');
      fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
      const reasons = rule.check(path.join(TEMP, testTicket));
      assert.equal(reasons.length, 1);
      assert.ok(reasons[0].toLowerCase().includes('qa'));
    } finally {
      if (savedWebApps === undefined) delete process.env.WEB_APPS;
      else process.env.WEB_APPS = savedWebApps;
      delete require.cache[require.resolve('../../lib/config')];
      delete require.cache[require.resolve('../check-gate')];
    }
  });

  it('qa-reports rule detects unapproved QA file when WEB_APPS is configured', () => {
    const savedWebApps = process.env.WEB_APPS;
    try {
      process.env.WEB_APPS = '[{"name":"test-app","defaultPort":3000,"type":"vite"}]';
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
      const { CHECK_GATE_RULES: freshRules } = require('../check-gate');
      writeReport('qa-feature.check.md', 'Status: FAILED');
      const rule = freshRules.find((r) => r.name === 'qa-reports');
      const reasons = rule.check(path.join(TEMP, testTicket));
      assert.equal(reasons.length, 1);
      assert.ok(reasons[0].includes('qa-feature.check.md'));
    } finally {
      if (savedWebApps === undefined) delete process.env.WEB_APPS;
      else process.env.WEB_APPS = savedWebApps;
      delete require.cache[require.resolve('../../lib/config')];
      delete require.cache[require.resolve('../check-gate')];
    }
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
    const savedWebApps = process.env.WEB_APPS;
    try {
      process.env.WEB_APPS = '[]';
      // Re-require to pick up env change — config caches WEB_APPS at load time
      // so we need to invalidate the config cache
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
      const { CHECK_GATE_RULES: freshRules } = require('../check-gate');
      const rule = freshRules.find((r) => r.name === 'qa-reports');
      fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
      const reasons = rule.check(path.join(TEMP, testTicket));
      assert.deepStrictEqual(reasons, [], 'qa-reports should pass when WEB_APPS is empty');
    } finally {
      if (savedWebApps === undefined) delete process.env.WEB_APPS;
      else process.env.WEB_APPS = savedWebApps;
      // Restore original modules
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
    }
  });

  it('qa-reports rule passes when WEB_APPS env is unset', () => {
    const savedWebApps = process.env.WEB_APPS;
    try {
      delete process.env.WEB_APPS;
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
      const { CHECK_GATE_RULES: freshRules } = require('../check-gate');
      const rule = freshRules.find((r) => r.name === 'qa-reports');
      fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
      const reasons = rule.check(path.join(TEMP, testTicket));
      assert.deepStrictEqual(reasons, [], 'qa-reports should pass when WEB_APPS is unset');
    } finally {
      if (savedWebApps === undefined) delete process.env.WEB_APPS;
      else process.env.WEB_APPS = savedWebApps;
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
    }
  });

  it('qa-reports rule still requires QA reports when WEB_APPS has entries', () => {
    const savedWebApps = process.env.WEB_APPS;
    try {
      process.env.WEB_APPS = '[{"name":"my-app","defaultPort":3000,"type":"vite"}]';
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
      const { CHECK_GATE_RULES: freshRules } = require('../check-gate');
      const rule = freshRules.find((r) => r.name === 'qa-reports');
      fs.mkdirSync(path.join(TEMP, testTicket), { recursive: true });
      const reasons = rule.check(path.join(TEMP, testTicket));
      assert.equal(
        reasons.length,
        1,
        'qa-reports should still require QA when WEB_APPS has entries'
      );
      assert.ok(reasons[0].toLowerCase().includes('qa'));
    } finally {
      if (savedWebApps === undefined) delete process.env.WEB_APPS;
      else process.env.WEB_APPS = savedWebApps;
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
    }
  });

  it('validateCheckGate passes with required reports and no QA when WEB_APPS empty', () => {
    const savedWebApps = process.env.WEB_APPS;
    try {
      process.env.WEB_APPS = '[]';
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
      const { validateCheckGate: freshValidate } = require('../check-gate');
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
    } finally {
      if (savedWebApps === undefined) delete process.env.WEB_APPS;
      else process.env.WEB_APPS = savedWebApps;
      const configPath = require.resolve('../../lib/config');
      const gatePath = require.resolve('../check-gate');
      delete require.cache[configPath];
      delete require.cache[gatePath];
    }
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
});

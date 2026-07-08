/**
 * workflow-definition.test.js
 *
 * Tests that workflow-definition.js exports declarative policy config:
 *   - archivalPatterns: per-step file patterns to archive on backward transitions
 *   - evidenceRequirements: per-step required report files / patterns
 *   - agentGatedScripts: script → { agents, step } map for Rule 5 gating
 *
 * GH-206 Task 12: Extract declarative workflow policy config.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const createWorkflowDefinition = require(path.join(__dirname, '..', 'workflow-definition'));
const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));

const configPath = path.resolve(__dirname, '..', '..', 'lib', 'config.js');

// Minimal deps stub — we only read static config, not call verify fns.
const stubDeps = {
  TASKS_BASE: '/tmp/tasks-base',
  safeTicketPath: (id) => id,
  resolveGitHead: () => 'ref: refs/heads/stub',
};

const { workflow } = createWorkflowDefinition(stubDeps);

describe('workflow-definition: archivalPatterns', () => {
  it('exports archivalPatterns object on workflow', () => {
    assert.ok(workflow.archivalPatterns, 'archivalPatterns should be exported');
    assert.equal(typeof workflow.archivalPatterns, 'object');
  });

  it('defines archival pattern for check step matching *.check.md files', () => {
    const patterns = workflow.archivalPatterns[STEPS.check];
    assert.ok(Array.isArray(patterns), 'check archival patterns should be an array');
    assert.ok(patterns.length > 0, 'check step should have at least one pattern');
    assert.ok(patterns.some((p) => p instanceof RegExp && p.test('code-review.check.md')));
    assert.ok(patterns.some((p) => p instanceof RegExp && p.test('tests.check.md')));
  });

  it('defines archival pattern for pr step matching pr update sha files', () => {
    const patterns = workflow.archivalPatterns[STEPS.pr];
    assert.ok(Array.isArray(patterns));
    const filenameA = ['.', 'pr-update-sha'].join('');
    const filenameB = ['.', 'post-pr-update-sha'].join('');
    assert.ok(patterns.some((p) => p instanceof RegExp && p.test(filenameA)));
    assert.ok(patterns.some((p) => p instanceof RegExp && p.test(filenameB)));
  });

  it('does NOT define archival for complete step (self-transition)', () => {
    assert.equal(workflow.archivalPatterns[STEPS.complete], undefined);
  });
});

describe('workflow-definition: evidenceRequirements', () => {
  it('exports evidenceRequirements object on workflow', () => {
    assert.ok(workflow.evidenceRequirements, 'evidenceRequirements should be exported');
    assert.equal(typeof workflow.evidenceRequirements, 'object');
  });

  it('defines required files for check step', () => {
    const reqs = workflow.evidenceRequirements[STEPS.check];
    assert.ok(reqs, 'check step should have evidence requirements');
    assert.ok(Array.isArray(reqs.requiredFiles), 'requiredFiles should be array');
    const required = reqs.requiredFiles;
    assert.ok(required.includes('code-review.check.md'));
    assert.ok(required.includes('tests.check.md'));
    assert.ok(required.includes('completion.check.md'));
    assert.ok(required.includes('README.md'));
  });

  it('defines qa report pattern for check step', () => {
    const reqs = workflow.evidenceRequirements[STEPS.check];
    assert.ok(reqs.qaReportPattern instanceof RegExp);
    assert.ok(reqs.qaReportPattern.test('qa-feature-tester.check.md'));
    assert.ok(reqs.qaReportPattern.test('qa-api-tester.check.md'));
    assert.ok(!reqs.qaReportPattern.test('tests.check.md'));
  });

  it('defines required approved files for reports step', () => {
    const reqs = workflow.evidenceRequirements[STEPS.reports];
    assert.ok(reqs, 'reports step should have evidence requirements');
    assert.ok(Array.isArray(reqs.requiredApprovals));
    const byFile = Object.fromEntries(reqs.requiredApprovals.map((r) => [r.file, r.pattern]));
    assert.ok(byFile['tests.check.md'] instanceof RegExp);
    assert.ok(byFile['code-review.check.md'] instanceof RegExp);
    assert.ok(byFile['completion.check.md'] instanceof RegExp);
    assert.ok(/APPROVED/i.test('Status: APPROVED'.match(byFile['tests.check.md'])?.[0] || ''));
  });
});

describe('workflow-definition: agentGatedScripts', () => {
  it('exports agentGatedScripts object on workflow', () => {
    assert.ok(workflow.agentGatedScripts, 'agentGatedScripts should be exported');
    assert.equal(typeof workflow.agentGatedScripts, 'object');
  });

  it('registers write-qa-report.js with qa-* agents at check step', () => {
    const entry = workflow.agentGatedScripts['write-qa-report.js'];
    assert.ok(entry);
    assert.ok(Array.isArray(entry.agents));
    assert.ok(entry.agents.includes('qa-feature-tester'));
    assert.ok(entry.agents.includes('qa-api-tester'));
    assert.equal(entry.step, STEPS.check);
  });

  it('registers write-tests-report.js with quality-checker at check step', () => {
    const entry = workflow.agentGatedScripts['write-tests-report.js'];
    assert.ok(entry);
    assert.deepEqual(entry.agents, ['quality-checker']);
    assert.equal(entry.step, STEPS.check);
  });

  it('registers write-code-review.js with code-checker at check step', () => {
    const entry = workflow.agentGatedScripts['write-code-review.js'];
    assert.ok(entry);
    assert.deepEqual(entry.agents, ['code-checker']);
    assert.equal(entry.step, STEPS.check);
  });

  it('registers write-completion-report.js with completion-checker at check step', () => {
    const entry = workflow.agentGatedScripts['write-completion-report.js'];
    assert.ok(entry);
    assert.deepEqual(entry.agents, ['completion-checker']);
    assert.equal(entry.step, STEPS.check);
  });

  it('registers tdd-phase-state.js with developer-* agents at implement step', () => {
    const entry = workflow.agentGatedScripts['tdd-phase-state.js'];
    assert.ok(entry);
    assert.ok(entry.agents.includes('developer-nodejs-tdd'));
    assert.ok(entry.agents.includes('developer-react-senior'));
    assert.ok(entry.agents.includes('developer-devops'));
    assert.equal(entry.step, STEPS.implement);
  });
});

// ─── GH-215 Task 7: brief_gate verify entry ─────────────────────────────────
//
// The verify function for STEPS.brief_gate must return true iff:
//   (1) brief.md exists under the ticket's tasks dir, AND
//   (2) openQuestions.findBlocking(parse(brief)) returns an empty array.
// It must never throw — any read/parse failure is a fail-closed `false`.
describe('workflow-definition: verify[STEPS.brief_gate]', () => {
  // Create a throwaway tasks base so each test can stage its own brief.md
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-def-briefgate-'));
  const ticketId = 'GH-215';
  const ticketDir = path.join(tmpRoot, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  const deps = {
    TASKS_BASE: tmpRoot,
    safeTicketPath: (id) => id,
    resolveGitHead: () => 'ref: refs/heads/stub',
  };
  const { workflow: briefGateWf } = createWorkflowDefinition(deps);

  // Locate the verify function on the commandMap.
  function getBriefGateVerify() {
    const entries = briefGateWf.commandMap.filter(
      (e) => e.step === STEPS.brief_gate && typeof e.verify === 'function'
    );
    return entries.length > 0 ? entries[0].verify : undefined;
  }

  function writeBrief(contents) {
    fs.writeFileSync(path.join(ticketDir, 'brief.md'), contents, 'utf-8');
  }
  function removeBrief() {
    const p = path.join(ticketDir, 'brief.md');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('registers a verify function for STEPS.brief_gate on the commandMap', () => {
    const verify = getBriefGateVerify();
    assert.equal(typeof verify, 'function', 'expected verify[STEPS.brief_gate] to be a function');
  });

  it('returns false when brief.md is missing (fail-closed)', () => {
    removeBrief();
    const verify = getBriefGateVerify();
    assert.equal(verify(ticketId), false);
  });

  it('returns false when brief has an unresolved architectural question', () => {
    writeBrief(
      [
        '# Brief',
        '',
        '## Open Questions',
        '',
        '- **Question:** Should we change the auth model?',
        '  - `scope: architectural`',
        '  - `rationale: touches session handling`',
        '  - `resolved: false`',
        '',
      ].join('\n')
    );
    const verify = getBriefGateVerify();
    assert.equal(verify(ticketId), false);
  });

  it('returns true when all questions are local or resolved', () => {
    writeBrief(
      [
        '# Brief',
        '',
        '## Open Questions',
        '',
        '- **Question:** What name should this helper use?',
        '  - `scope: local`',
        '  - `rationale: naming only, no cross-cutting impact`',
        '  - `resolved: false`',
        '',
        '- **Question:** Should we change the auth model?',
        '  - `scope: architectural`',
        '  - `rationale: resolved during planning`',
        '  - `resolved: true`',
        '  - **Resolution:** Keep existing model.',
        '',
      ].join('\n')
    );
    const verify = getBriefGateVerify();
    assert.equal(verify(ticketId), true);
  });

  it('returns false for a malformed brief read error (fail-closed)', () => {
    // Remove the brief and place a directory at its path so read/parse fails.
    removeBrief();
    const briefPath = path.join(ticketDir, 'brief.md');
    fs.mkdirSync(briefPath);
    try {
      const verify = getBriefGateVerify();
      assert.equal(verify(ticketId), false);
    } finally {
      fs.rmdirSync(briefPath);
    }
  });
});

// ─── GH-211 Task 6: task_review verify entry + softSteps ─────────────────────
describe('workflow-definition: verify[STEPS.task_review]', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-def-taskreview-'));
  const ticketId = 'GH-211';
  const ticketDir = path.join(tmpRoot, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  const deps = {
    TASKS_BASE: tmpRoot,
    safeTicketPath: (id) => id,
    resolveGitHead: () => 'ref: refs/heads/stub',
  };
  const { workflow: trWf } = createWorkflowDefinition(deps);

  function getTaskReviewVerify() {
    const entries = trWf.commandMap.filter(
      (e) => e.step === STEPS.task_review && typeof e.verify === 'function'
    );
    return entries.length > 0 ? entries[0].verify : undefined;
  }

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('registers a verify function for STEPS.task_review on the commandMap', () => {
    const verify = getTaskReviewVerify();
    assert.equal(typeof verify, 'function', 'expected verify[STEPS.task_review] to be a function');
  });

  it('returns false when no review artifacts exist', () => {
    const verify = getTaskReviewVerify();
    assert.equal(verify(ticketId), false);
  });

  it('returns true when task-review-tests.md exists', () => {
    fs.writeFileSync(path.join(ticketDir, 'task-review-tests.md'), '# Test Review\nAll good');
    const verify = getTaskReviewVerify();
    assert.equal(verify(ticketId), true);
    fs.unlinkSync(path.join(ticketDir, 'task-review-tests.md'));
  });

  it('returns true when task-review-code.md exists', () => {
    fs.writeFileSync(path.join(ticketDir, 'task-review-code.md'), '# Code Review\nAll good');
    const verify = getTaskReviewVerify();
    assert.equal(verify(ticketId), true);
    fs.unlinkSync(path.join(ticketDir, 'task-review-code.md'));
  });

  it('returns true when both review artifacts exist', () => {
    fs.writeFileSync(path.join(ticketDir, 'task-review-tests.md'), '# Test Review');
    fs.writeFileSync(path.join(ticketDir, 'task-review-code.md'), '# Code Review');
    const verify = getTaskReviewVerify();
    assert.equal(verify(ticketId), true);
    fs.unlinkSync(path.join(ticketDir, 'task-review-tests.md'));
    fs.unlinkSync(path.join(ticketDir, 'task-review-code.md'));
  });

  it('returns false gracefully when tasksDir does not exist', () => {
    const badDeps = {
      TASKS_BASE: '/tmp/nonexistent-workflow-def-test',
      safeTicketPath: (id) => id,
      resolveGitHead: () => 'ref: refs/heads/stub',
    };
    const { workflow: badWf } = createWorkflowDefinition(badDeps);
    const entries = badWf.commandMap.filter(
      (e) => e.step === STEPS.task_review && typeof e.verify === 'function'
    );
    assert.equal(entries[0].verify('NONEXISTENT'), false);
  });
});

describe('workflow-definition: softSteps includes task_review', () => {
  it('has task_review in softSteps set', () => {
    assert.ok(workflow.softSteps.has(STEPS.task_review), 'task_review should be in softSteps');
  });
});

// ─── GH-219: brief.md contentGuard ───────────────────────────────────────────

describe('workflow-definition: brief.md contentGuard', () => {
  const { artifactRules } = createWorkflowDefinition(stubDeps);

  function getBriefRule() {
    return artifactRules.find((r) => r.basename === 'brief.md');
  }

  const BRIEF_WITH_RESOLVED_ARCHITECTURAL = [
    '# Brief',
    '',
    '## Open Questions',
    '',
    '- **Question:** Should we change the auth model?',
    '  - `scope: architectural`',
    '  - `rationale: touches session handling`',
    '  - `resolved: true`',
    '  - **Resolution:** Yes, use OAuth.',
    '',
  ].join('\n');

  const BRIEF_WITH_RESOLVED_CROSS_TICKET = [
    '# Brief',
    '',
    '## Open Questions',
    '',
    '- **Question:** Does team X need to update their service?',
    '  - `scope: cross-ticket`',
    '  - `rationale: depends on external team`',
    '  - `resolved: true`',
    '  - **Resolution:** They will update independently.',
    '',
  ].join('\n');

  const BRIEF_WITH_UNRESOLVED_ARCHITECTURAL = [
    '# Brief',
    '',
    '## Open Questions',
    '',
    '- **Question:** Should we change the auth model?',
    '  - `scope: architectural`',
    '  - `rationale: touches session handling`',
    '  - `resolved: false`',
    '',
  ].join('\n');

  const BRIEF_WITH_RESOLVED_LOCAL = [
    '# Brief',
    '',
    '## Open Questions',
    '',
    '- **Question:** What name should this helper use?',
    '  - `scope: local`',
    '  - `rationale: naming only`',
    '  - `resolved: true`',
    '  - **Resolution:** Use parseQuestions.',
    '',
  ].join('\n');

  it('has a contentGuard on the brief.md artifact rule', () => {
    const rule = getBriefRule();
    assert.equal(typeof rule.contentGuard, 'function');
  });

  it('blocks resolved architectural questions during brief step', () => {
    const rule = getBriefRule();
    const result = rule.contentGuard(BRIEF_WITH_RESOLVED_ARCHITECTURAL, STEPS.brief);
    assert.equal(result.blocked, true);
    assert.ok(result.message.includes('BLOCKED'));
    assert.ok(result.message.includes('1'));
  });

  it('blocks resolved cross-ticket questions during brief step', () => {
    const rule = getBriefRule();
    const result = rule.contentGuard(BRIEF_WITH_RESOLVED_CROSS_TICKET, STEPS.brief);
    assert.equal(result.blocked, true);
    assert.ok(result.message.includes('BLOCKED'));
  });

  it('allows resolved architectural questions during brief_gate step', () => {
    const rule = getBriefRule();
    const result = rule.contentGuard(BRIEF_WITH_RESOLVED_ARCHITECTURAL, STEPS.brief_gate);
    assert.equal(result.blocked, false);
  });

  it('allows unresolved architectural questions during brief step', () => {
    const rule = getBriefRule();
    const result = rule.contentGuard(BRIEF_WITH_UNRESOLVED_ARCHITECTURAL, STEPS.brief);
    assert.equal(result.blocked, false);
  });

  it('allows resolved local questions during brief step', () => {
    const rule = getBriefRule();
    const result = rule.contentGuard(BRIEF_WITH_RESOLVED_LOCAL, STEPS.brief);
    assert.equal(result.blocked, false);
  });

  it('fails open when content has no open questions section', () => {
    const rule = getBriefRule();
    const result = rule.contentGuard('# Brief\n\nJust a normal brief.', STEPS.brief);
    assert.equal(result.blocked, false);
  });
});

// ─── GH-253 Task 3: spec step verify (toggle removed) ────────────────────────
describe('workflow-definition: verify[STEPS.spec] (no toggle)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-def-spec-notoggle-'));
  const ticketId = 'GH-253';
  const ticketDir = path.join(tmpRoot, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  const deps = {
    TASKS_BASE: tmpRoot,
    safeTicketPath: (id) => id,
    resolveGitHead: () => 'ref: refs/heads/stub',
  };
  const { workflow: specWf } = createWorkflowDefinition(deps);

  function getSpecVerify() {
    const entries = specWf.commandMap.filter(
      (e) => e.step === STEPS.spec && typeof e.verify === 'function'
    );
    return entries.length > 0 ? entries[0].verify : undefined;
  }

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('returns false when spec.md does not exist', () => {
    const verify = getSpecVerify();
    assert.equal(verify(ticketId), false);
  });

  it('returns true when spec.md exists', () => {
    fs.writeFileSync(path.join(ticketDir, 'spec.md'), '# Spec\nContent');
    const verify = getSpecVerify();
    assert.equal(verify(ticketId), true);
    fs.unlinkSync(path.join(ticketDir, 'spec.md'));
  });

  it('does not auto-verify when WORK_SPEC_ENABLED=0 (toggle removed)', () => {
    const saved = process.env.WORK_SPEC_ENABLED;
    try {
      process.env.WORK_SPEC_ENABLED = '0';
      const verify = getSpecVerify();
      // spec.md does not exist, so verify should return false regardless of env
      assert.equal(verify(ticketId), false);
    } finally {
      if (saved === undefined) delete process.env.WORK_SPEC_ENABLED;
      else process.env.WORK_SPEC_ENABLED = saved;
    }
  });
});

// ─── GH-244: spec_gate verify entry ──────────────────────────────────────────
describe('workflow-definition: verify[STEPS.spec_gate]', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-def-specgate-'));
  const ticketId = 'GH-244';
  const ticketDir = path.join(tmpRoot, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });

  const deps = {
    TASKS_BASE: tmpRoot,
    safeTicketPath: (id) => id,
    resolveGitHead: () => 'ref: refs/heads/stub',
  };
  const { workflow: specGateWf } = createWorkflowDefinition(deps);

  function getSpecGateVerify() {
    const entries = specGateWf.commandMap.filter(
      (e) => e.step === STEPS.spec_gate && typeof e.verify === 'function'
    );
    return entries.length > 0 ? entries[0].verify : undefined;
  }

  function writeSpec(contents) {
    fs.writeFileSync(path.join(ticketDir, 'spec.md'), contents, 'utf-8');
  }
  function writeGherkin(contents) {
    fs.writeFileSync(path.join(ticketDir, 'gherkin.feature'), contents, 'utf-8');
  }
  function removeSpec() {
    const p = path.join(ticketDir, 'spec.md');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  function removeGherkin() {
    const p = path.join(ticketDir, 'gherkin.feature');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  // GH-253 Task 3: WORK_SPEC_ENABLED toggle removed — spec is always mandatory.
  // verifySpecGate no longer checks process.env.WORK_SPEC_ENABLED.

  it('returns false when spec.md does not exist (fail-closed)', () => {
    removeSpec();
    removeGherkin();
    const verify = getSpecGateVerify();
    assert.equal(verify(ticketId), false);
  });

  it('returns false when gherkin.feature does not exist (fail-closed)', () => {
    writeSpec('# Spec\n');
    removeGherkin();
    const verify = getSpecGateVerify();
    assert.equal(verify(ticketId), false);
  });

  it('returns true when skip override <!-- gherkin-skip: reason --> is present in gherkin.feature', () => {
    writeSpec('# Spec\n');
    writeGherkin(
      [
        '<!-- gherkin-skip: trivial change -->',
        'Feature: Test',
        '  Scenario: Only one',
        '    Given something',
        '    When action',
        '    Then result',
      ].join('\n')
    );
    const verify = getSpecGateVerify();
    assert.equal(verify(ticketId), true);
  });

  it('returns true when Gherkin validates (2+ scenarios with @integration)', () => {
    writeSpec('# Spec\n');
    writeGherkin(
      [
        'Feature: Test',
        '  @integration',
        '  Scenario: First',
        '    Given something',
        '    When action',
        '    Then result',
        '  @e2e',
        '  Scenario: Second',
        '    Given other',
        '    When act',
        '    Then done',
      ].join('\n')
    );
    const verify = getSpecGateVerify();
    assert.equal(verify(ticketId), true);
  });

  it('returns false when validation fails (1 scenario only)', () => {
    writeSpec('# Spec\n');
    writeGherkin(
      [
        'Feature: Test',
        '  @integration',
        '  Scenario: Only one',
        '    Given something',
        '    When action',
        '    Then result',
      ].join('\n')
    );
    const verify = getSpecGateVerify();
    assert.equal(verify(ticketId), false);
  });

  // GH-253 Task 3: verify WORK_SPEC_ENABLED is not referenced anywhere in workflow-definition.js
  it('does not reference WORK_SPEC_ENABLED in the module source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'workflow-definition.js'), 'utf-8');
    assert.ok(
      !src.includes('WORK_SPEC_ENABLED'),
      'workflow-definition.js should not reference WORK_SPEC_ENABLED'
    );
  });

  it('returns false when parse has errors but validation would pass (malformed Gherkin)', () => {
    // Write something that triggers parse errors — e.g. a Feature with no valid
    // Scenario keyword (just gibberish lines after Feature:)
    writeSpec(
      [
        '# Spec',
        '## Test Scenarios (Gherkin)',
        'Feature: Broken',
        '  This is not a valid Gherkin line',
        '  Another invalid line',
      ].join('\n')
    );
    const verify = getSpecGateVerify();
    assert.equal(verify(ticketId), false);
  });
});

describe('workflow-definition: verify[STEPS.check] QA report gating', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-def-check-'));
  const ticketId = 'GH-232';
  const ticketDir = path.join(tmpRoot, ticketId);

  const deps = {
    TASKS_BASE: tmpRoot,
    safeTicketPath: (id) => id,
    resolveGitHead: () => 'ref: refs/heads/stub',
  };
  const { workflow: checkWf } = createWorkflowDefinition(deps);

  function getCheckVerify() {
    const entries = checkWf.commandMap.filter(
      (e) => e.step === STEPS.check && typeof e.verify === 'function'
    );
    return entries.length > 0 ? entries[0].verify : undefined;
  }

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function setupTicketDir(files) {
    fs.rmSync(ticketDir, { recursive: true, force: true });
    fs.mkdirSync(ticketDir, { recursive: true });
    for (const f of files) {
      fs.writeFileSync(path.join(ticketDir, f), 'placeholder');
    }
  }

  function callVerifyWithWebApps(webApps) {
    const savedWebApps = process.env.WEB_APPS;
    delete require.cache[configPath];
    process.env.WEB_APPS = JSON.stringify(webApps);
    try {
      const verify = getCheckVerify();
      return verify(ticketId);
    } finally {
      if (savedWebApps !== undefined) {
        process.env.WEB_APPS = savedWebApps;
      } else {
        delete process.env.WEB_APPS;
      }
      delete require.cache[configPath];
    }
  }

  it('passes without QA report when no web apps configured', () => {
    setupTicketDir(['code-review.check.md', 'tests.check.md', 'completion.check.md', 'README.md']);
    assert.equal(callVerifyWithWebApps([]), true);
  });

  it('fails without QA report when web apps are configured', () => {
    setupTicketDir(['code-review.check.md', 'tests.check.md', 'completion.check.md', 'README.md']);
    assert.equal(
      callVerifyWithWebApps([{ name: 'my-app', defaultPort: 3000, type: 'vite' }]),
      false
    );
  });

  it('passes with QA report when web apps are configured', () => {
    setupTicketDir([
      'code-review.check.md',
      'tests.check.md',
      'completion.check.md',
      'README.md',
      'qa-feature-tester.check.md',
    ]);
    assert.equal(
      callVerifyWithWebApps([{ name: 'my-app', defaultPort: 3000, type: 'vite' }]),
      true
    );
  });
});

// ─── GH-321 Task 4: tasks.md contentGuard ─────────────────────────────────────

describe('workflow-definition: tasks.md contentGuard', () => {
  const { artifactRules } = createWorkflowDefinition(stubDeps);

  function getTasksRule() {
    return artifactRules.find((r) => r.basename === 'tasks.md');
  }

  it('has a contentGuard on the tasks.md artifact rule', () => {
    const rule = getTasksRule();
    assert.ok(rule, 'tasks.md rule should exist in artifactRules');
    assert.equal(typeof rule.contentGuard, 'function', 'tasks.md should have a contentGuard');
  });

  it('tasks.md contentGuard blocks vague descriptions', () => {
    const rule = getTasksRule();
    const result = rule.contentGuard('## Task 1 — Test\n\n### Description\nTBD\n');
    assert.equal(result.blocked, true);
    assert.ok(result.message, 'blocked result should include a message');
  });

  it('tasks.md contentGuard allows valid descriptions', () => {
    const rule = getTasksRule();
    const result = rule.contentGuard(
      '## Task 1 — Test\n\n### Description\nImplement the user authentication flow with JWT tokens\n'
    );
    assert.equal(result.blocked, false);
  });
});

// ─── GH-326 Task 1.2: .check.md contentGuard ─────────────────────────────────
describe('workflow-definition: .check.md contentGuard', () => {
  const { artifactRules } = createWorkflowDefinition(stubDeps);

  function getRule(basename) {
    return artifactRules.find((r) => r.basename === basename);
  }

  // --- contentGuard presence ---
  it('has a contentGuard on tests.check.md artifact rule', () => {
    const rule = getRule('tests.check.md');
    assert.equal(typeof rule.contentGuard, 'function');
  });

  it('has a contentGuard on code-review.check.md artifact rule', () => {
    const rule = getRule('code-review.check.md');
    assert.equal(typeof rule.contentGuard, 'function');
  });

  it('has a contentGuard on completion.check.md artifact rule', () => {
    const rule = getRule('completion.check.md');
    assert.equal(typeof rule.contentGuard, 'function');
  });

  // --- contentGuard blocks missing Status line ---
  it('blocks tests.check.md without Status line', () => {
    const rule = getRule('tests.check.md');
    const result = rule.contentGuard('# Test Report\nAll tests pass', STEPS.check);
    assert.equal(result.blocked, true);
    assert.ok(result.message.includes('Status:'), 'message should mention Status:');
  });

  it('blocks code-review.check.md without Status line', () => {
    const rule = getRule('code-review.check.md');
    const result = rule.contentGuard('# Code Review\nLooks good', STEPS.check);
    assert.equal(result.blocked, true);
    assert.ok(result.message);
  });

  it('blocks completion.check.md without Status line', () => {
    const rule = getRule('completion.check.md');
    const result = rule.contentGuard('# Completion Report\nAll done', STEPS.check);
    assert.equal(result.blocked, true);
    assert.ok(result.message);
  });

  // --- contentGuard allows valid Status line ---
  it('allows tests.check.md with "Status: APPROVED"', () => {
    const rule = getRule('tests.check.md');
    const result = rule.contentGuard('Status: APPROVED\n# Test Report', STEPS.check);
    assert.equal(result.blocked, false);
  });

  it('allows code-review.check.md with "Status: NEEDS_WORK"', () => {
    const rule = getRule('code-review.check.md');
    const result = rule.contentGuard('Status: NEEDS_WORK\n# Code Review', STEPS.check);
    assert.equal(result.blocked, false);
  });

  it('allows completion.check.md with "Status: COMPLETE"', () => {
    const rule = getRule('completion.check.md');
    const result = rule.contentGuard('Status: COMPLETE\n# Completion Report', STEPS.check);
    assert.equal(result.blocked, false);
  });

  // --- contentGuard blocks invalid status for type ---
  it('blocks tests.check.md with Status: COMPLETE (invalid for tests)', () => {
    const rule = getRule('tests.check.md');
    const result = rule.contentGuard('Status: COMPLETE\n# Test Report', STEPS.check);
    assert.equal(result.blocked, true);
  });

  it('blocks code-review.check.md with Status: COMPLETE (invalid for codeReview)', () => {
    const rule = getRule('code-review.check.md');
    const result = rule.contentGuard('Status: COMPLETE\n# Code Review', STEPS.check);
    assert.equal(result.blocked, true);
  });

  // --- contentGuard allows bold markdown variants ---
  it('allows tests.check.md with "**Status:** **APPROVED**"', () => {
    const rule = getRule('tests.check.md');
    const result = rule.contentGuard('**Status:** **APPROVED**\n# Report', STEPS.check);
    assert.equal(result.blocked, false);
  });

  // --- contentGuard blocks freeform status without Status: prefix ---
  it('blocks code-review.check.md with standalone "**APPROVED**" (no Status: prefix)', () => {
    const rule = getRule('code-review.check.md');
    const result = rule.contentGuard('# Code Review\n\n**APPROVED**\nLooks good', STEPS.check);
    assert.equal(result.blocked, true);
  });
});

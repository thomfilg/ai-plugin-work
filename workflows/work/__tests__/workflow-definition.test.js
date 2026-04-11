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

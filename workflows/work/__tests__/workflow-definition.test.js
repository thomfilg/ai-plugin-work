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

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

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

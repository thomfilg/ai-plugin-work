/**
 * Tests for the GH-247 post-check Gherkin scope validator:
 * declared spec scope (gherkin-skip override + @unit/@integration/@e2e tags)
 * vs the actual committed diff. One test per detection-rule row, plus the
 * 4b_gherkin_scope step wiring (report + block instruction) against a real
 * temp git repo.
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { evaluateGherkinScope, classifyChanges, declaredScope } = require('../lib/gherkin-scope');
const registerGherkinScope = require('../lib/steps/gherkin-scope');

// ─── Spec fixtures ──────────────────────────────────────────────────────────

const SPEC_WITH_ALL_TAGS = [
  '# Spec',
  '',
  '## Test Scenarios (Gherkin)',
  '',
  'Feature: Widget',
  '',
  '  @unit',
  '  Scenario: computes',
  '    Given a widget',
  '    Then it computes',
  '',
  '  @integration',
  '  Scenario: persists',
  '    Given a widget',
  '    Then it persists',
  '',
  '  @e2e',
  '  Scenario: renders',
  '    Given a widget',
  '    Then it renders',
  '',
].join('\n');

const SPEC_UNIT_ONLY = [
  '# Spec',
  '',
  '## Test Scenarios (Gherkin)',
  '',
  'Feature: Widget',
  '',
  '  @unit',
  '  Scenario: computes',
  '    Given a widget',
  '    Then it computes',
  '',
].join('\n');

const SPEC_WITH_SKIP = ['# Spec', '', '<!-- gherkin-skip: docs-only -->', ''].join('\n');

// ─── Pure detection rules (issue table) ─────────────────────────────────────

describe('evaluateGherkinScope — GH-247 detection rules', () => {
  it('BLOCKs when UI files changed but spec has no @e2e scenarios', () => {
    const r = evaluateGherkinScope({
      specText: SPEC_UNIT_ONLY,
      files: ['components/widget.tsx', 'styles/widget.css'],
    });
    assert.equal(r.verdict, 'BLOCK');
    const v = r.violations.find((x) => x.requiredTag === '@e2e');
    assert.ok(v, 'expected an @e2e violation');
    assert.ok(v.files.includes('components/widget.tsx'));
    assert.ok(v.files.includes('styles/widget.css'));
    assert.match(r.reasons.join(' '), /spec scope mismatch: e2e scenarios required/);
  });

  it('BLOCKs when UI files changed and spec declares gherkin-skip', () => {
    const r = evaluateGherkinScope({
      specText: SPEC_WITH_SKIP,
      files: ['app/page.jsx'],
    });
    assert.equal(r.verdict, 'BLOCK');
    assert.equal(r.violations[0].requiredTag, '@e2e');
    assert.match(r.violations[0].why, /gherkin-skip: docs-only/);
  });

  it('BLOCKs when backend files changed but spec has no @integration scenarios', () => {
    const r = evaluateGherkinScope({
      specText: SPEC_UNIT_ONLY,
      files: ['src/routes/users.ts', 'migrations/002_add_col.sql', 'src/services/user-service.ts'],
    });
    assert.equal(r.verdict, 'BLOCK');
    const v = r.violations.find((x) => x.requiredTag === '@integration');
    assert.ok(v, 'expected an @integration violation');
    assert.equal(v.files.length, 3);
    assert.match(r.reasons.join(' '), /integration scenarios required/);
  });

  it('BLOCKs on both axes when a fullstack change has neither tag', () => {
    const r = evaluateGherkinScope({
      specText: SPEC_UNIT_ONLY,
      files: ['components/widget.tsx', 'app/api/widget/route.ts'],
    });
    assert.equal(r.verdict, 'BLOCK');
    assert.deepEqual(r.violations.map((v) => v.requiredTag).sort(), ['@e2e', '@integration']);
  });

  it('PASSes docs/config-only changes with gherkin-skip (skip is valid)', () => {
    const r = evaluateGherkinScope({
      specText: SPEC_WITH_SKIP,
      files: ['README.md', '.github/workflows/ci.yml', 'eslint.config.js'],
    });
    assert.equal(r.verdict, 'PASS');
    assert.match(r.reasons.join(' '), /skip.*valid|valid.*skip/i);
  });

  it('PASSes test-only changes regardless of declared scope', () => {
    const r = evaluateGherkinScope({
      specText: SPEC_WITH_SKIP,
      files: [
        'src/__tests__/widget.test.tsx',
        'tests/e2e/specs/widget.spec.ts',
        'src/utils/format.test.ts',
      ],
    });
    assert.equal(r.verdict, 'PASS');
    assert.match(r.reasons.join(' '), /Only test files/);
  });

  it('WARNs (never blocks) when spec.md is absent and UI files changed', () => {
    for (const specText of [null, '', '   \n']) {
      const r = evaluateGherkinScope({ specText, files: ['components/widget.tsx'] });
      assert.equal(r.verdict, 'WARN');
      assert.match(r.reasons.join(' '), /spec\.md is absent/);
    }
  });

  it('PASSes when declared tags cover the actual changes', () => {
    const r = evaluateGherkinScope({
      specText: SPEC_WITH_ALL_TAGS,
      files: ['components/widget.tsx', 'app/api/widget/route.ts', 'lib/widget-schemas.ts'],
    });
    assert.equal(r.verdict, 'PASS');
  });

  it('PASSes when there are no committed changes vs base', () => {
    const r = evaluateGherkinScope({ specText: SPEC_UNIT_ONLY, files: [] });
    assert.equal(r.verdict, 'PASS');
  });
});

describe('classifyChanges / declaredScope helpers', () => {
  it('classifies test files ahead of ui/backend (a .spec.tsx is a test, not UI)', () => {
    const b = classifyChanges(['components/widget.spec.tsx', 'app/api/x/route.test.ts']);
    assert.equal(b.tests.length, 2);
    assert.equal(b.ui.length, 0);
    assert.equal(b.backend.length, 0);
  });

  it('reuses the shared backend classifier (app/api, prisma, server)', () => {
    const b = classifyChanges(['prisma/schema.prisma', 'server/index.ts', 'app/api/x/route.ts']);
    assert.equal(b.backend.length, 3);
  });

  it('collects tags case-insensitively and reads the skip override', () => {
    const d = declaredScope(SPEC_WITH_ALL_TAGS);
    assert.equal(d.hasSpec, true);
    assert.equal(d.skip.skip, false);
    assert.deepEqual([...d.tags].sort(), ['@e2e', '@integration', '@unit']);

    const s = declaredScope(SPEC_WITH_SKIP);
    assert.equal(s.skip.skip, true);
    assert.equal(s.skip.reason, 'docs-only');
  });
});

// ─── Step wiring (4b_gherkin_scope) against a real temp git repo ────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(base, rel, content) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function getHandler() {
  const handlers = {};
  registerGherkinScope((name, fn) => {
    handlers[name] = fn;
  });
  assert.ok(handlers['4b_gherkin_scope'], 'step must register as 4b_gherkin_scope');
  return handlers['4b_gherkin_scope'];
}

describe('4b_gherkin_scope step', () => {
  let repo;
  let tasksDir;
  let originalCwd;
  let originalBaseBranch;

  before(() => {
    originalCwd = process.cwd();
    originalBaseBranch = process.env.BASE_BRANCH;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gherkin-scope-repo-'));
    tasksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gherkin-scope-tasks-'));

    sh('git init -q -b main', repo);
    write(repo, 'README.md', 'hi\n');
    sh('git add -A && git commit -q -m base', repo);
    sh('git update-ref refs/remotes/origin/main HEAD', repo);

    // Branch work: commit a UI file (spec below is @unit-only → BLOCK).
    sh('git checkout -q -b feature', repo);
    write(repo, 'components/widget.tsx', 'export const W = 1;\n');
    sh('git add -A && git commit -q -m ui-change', repo);

    process.chdir(repo);
    process.env.BASE_BRANCH = 'main';
  });

  after(() => {
    process.chdir(originalCwd);
    if (originalBaseBranch === undefined) delete process.env.BASE_BRANCH;
    else process.env.BASE_BRANCH = originalBaseBranch;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(tasksDir, { recursive: true, force: true });
  });

  it('BLOCKs a committed UI change against a @unit-only spec, naming file + missing type', () => {
    fs.writeFileSync(path.join(tasksDir, 'spec.md'), SPEC_UNIT_ONLY);
    const handler = getHandler();
    const state = { ticketId: 'GH-247', changesHash: 'abc123', setupResult: null };
    const result = handler(state, { tasksDir });

    assert.ok(result, 'expected a blocking instruction');
    assert.equal(result.action, 'failed');
    assert.equal(result.state.currentStep, '4b_gherkin_scope');
    assert.match(result.reason, /e2e scenarios required/);
    assert.match(result.reason, /components\/widget\.tsx/);
    assert.match(result.reason, /transition back to the spec step/i);

    const report = fs.readFileSync(result.report, 'utf8');
    assert.ok(
      report.startsWith('**Status:** NEEDS_WORK'),
      'report must lead with canonical status'
    );
    assert.match(report, /Missing @e2e scenarios/);
    assert.match(report, /components\/widget\.tsx/);
    assert.match(report, /Verified at abc123/);
  });

  it('auto-advances (null) with an APPROVED report when the spec covers the change', () => {
    fs.writeFileSync(path.join(tasksDir, 'spec.md'), SPEC_WITH_ALL_TAGS);
    const handler = getHandler();
    const state = { ticketId: 'GH-247', changesHash: 'abc123', setupResult: null };
    const result = handler(state, { tasksDir });

    assert.equal(result, null);
    const report = fs.readFileSync(path.join(tasksDir, 'gherkin-scope.check.md'), 'utf8');
    assert.ok(report.startsWith('**Status:** APPROVED'));
    assert.match(report, /\*\*Verdict:\*\* PASS/);
  });

  it('warns (APPROVED, auto-advance) when spec.md is absent', () => {
    fs.rmSync(path.join(tasksDir, 'spec.md'), { force: true });
    const handler = getHandler();
    const state = { ticketId: 'GH-247', changesHash: 'abc123', setupResult: null };
    const result = handler(state, { tasksDir });

    assert.equal(result, null);
    const report = fs.readFileSync(path.join(tasksDir, 'gherkin-scope.check.md'), 'utf8');
    assert.ok(report.startsWith('**Status:** APPROVED'));
    assert.match(report, /\*\*Verdict:\*\* WARN/);
    assert.match(report, /spec\.md is absent/);
  });
});

describe('step registry wiring', () => {
  it('places 4b_gherkin_scope between 4_run_tests and 5_phase1_agents', () => {
    const { STEPS } = require('../lib/step-registry');
    const i = STEPS.indexOf('4b_gherkin_scope');
    assert.ok(i > 0, 'step must be in STEPS');
    assert.equal(STEPS[i - 1], '4_run_tests');
    assert.equal(STEPS[i + 1], '5_phase1_agents');
  });
});

// ─── Cwd-independent worktree resolution (PR #669 review) ───────────────────

describe('resolveWorktreeRoot — ticket-config resolution beats ambient cwd', () => {
  const { resolveWorktreeRoot } = require('../lib/gherkin-scope');

  let ticketRepo;
  let otherRepo;

  before(() => {
    ticketRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gherkin-ticket-repo-'));
    otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gherkin-other-repo-'));
    sh('git init -q -b main', ticketRepo);
    sh('git init -q -b main', otherRepo);
  });

  after(() => {
    fs.rmSync(ticketRepo, { recursive: true, force: true });
    fs.rmSync(otherRepo, { recursive: true, force: true });
  });

  it('resolves the TICKET worktree from config even when cwd is a different repo', () => {
    const fakeConfig = {
      safeTicketId: (t) => t,
      worktreeDir: () => ticketRepo,
    };
    const root = resolveWorktreeRoot(otherRepo, 'GH-247', { config: fakeConfig });
    assert.equal(fs.realpathSync(root), fs.realpathSync(ticketRepo));
  });

  it('falls back to ambient git toplevel when the ticket resolves to nothing', () => {
    const fakeConfig = {
      safeTicketId: (t) => t,
      worktreeDir: () => path.join(os.tmpdir(), 'does-not-exist-anywhere-12345'),
    };
    // pluginToplevel: null → resolveTicketWorktree's own cwd fallback also
    // engages; either way the ambient repo must win.
    const root = resolveWorktreeRoot(otherRepo, 'GH-247', {
      config: fakeConfig,
      pluginToplevel: null,
    });
    assert.equal(fs.realpathSync(root), fs.realpathSync(otherRepo));
  });

  it('without a ticket id, behaves as before (ambient git toplevel)', () => {
    const root = resolveWorktreeRoot(otherRepo);
    assert.equal(fs.realpathSync(root), fs.realpathSync(otherRepo));
  });
});

describe('4b_gherkin_scope step — CHECK_GHERKIN_SCOPE=0 off-switch', () => {
  let tasksDir2;
  let savedToggle;

  before(() => {
    tasksDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gherkin-toggle-tasks-'));
    savedToggle = process.env.CHECK_GHERKIN_SCOPE;
    process.env.CHECK_GHERKIN_SCOPE = '0';
  });

  after(() => {
    if (savedToggle === undefined) delete process.env.CHECK_GHERKIN_SCOPE;
    else process.env.CHECK_GHERKIN_SCOPE = savedToggle;
    fs.rmSync(tasksDir2, { recursive: true, force: true });
  });

  it('auto-passes with a SKIPPED note and never blocks', () => {
    // Spec that would BLOCK if the validator ran (no tags, UI diff irrelevant
    // — the step must not even look at git).
    fs.writeFileSync(path.join(tasksDir2, 'spec.md'), SPEC_UNIT_ONLY);
    const handler = getHandler();
    const state = { ticketId: 'GH-247', changesHash: 'abc123', setupResult: null };
    const result = handler(state, { tasksDir: tasksDir2 });

    assert.equal(result, null, 'must auto-advance');
    const report = fs.readFileSync(path.join(tasksDir2, 'gherkin-scope.check.md'), 'utf8');
    assert.ok(report.startsWith('**Status:** APPROVED'));
    assert.match(report, /\*\*Verdict:\*\* SKIPPED/);
    assert.match(report, /CHECK_GHERKIN_SCOPE=0/);
  });
});

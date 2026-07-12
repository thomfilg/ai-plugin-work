'use strict';

/**
 * Tests for lib/phase-ledger.js (GH-696) — the ONE shared "inner phase ledger
 * is terminal" predicate — plus its verifier consumers: step verifiers
 * (verifyBrief/verifySpec/verifyTasks) and gate verifiers (verifyBriefGate/
 * verifySpecGate) must refuse to vouch while the step's *-phase.json ledger
 * is mid-flight (the GH-689 race: outer auto-advance closed the artifact
 * window while the writer agent was mid-DRAFT).
 *
 * Contract:
 *   - absent ledger file      → not blocked (legacy/pre-phase-driver tickets)
 *   - currentPhase terminal   → not blocked
 *   - currentPhase non-terminal → blocked
 *   - unreadable/corrupt JSON → blocked, currentPhase UNPARSEABLE_PHASE (fail
 *     closed; repair = operator escalation — re-dispatch cannot fix a corrupt
 *     ledger, the runner dies reading the same file; the plan matrix routes
 *     to AskUserQuestion instead, PR #718)
 *
 * Run: node --test workflows/work/__tests__/phase-ledger.test.js
 */

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { phaseLedgerBlocked, STEP_LEDGERS, UNPARSEABLE_PHASE } = require('../lib/phase-ledger');
const { createStepVerifiers } = require('../workflow-def/step-verifiers');
const { createGateVerifiers } = require('../workflow-def/gate-verifiers');

const workRoot = path.join(__dirname, '..');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-ledger-'));
const ticketId = 'GH-696';
const ticketDir = path.join(tmpRoot, ticketId);
fs.mkdirSync(ticketDir, { recursive: true });

function writeLedger(file, currentPhase) {
  fs.writeFileSync(path.join(ticketDir, file), JSON.stringify({ currentPhase }), 'utf-8');
}

function clearTicketDir() {
  for (const f of fs.readdirSync(ticketDir)) {
    fs.rmSync(path.join(ticketDir, f), { recursive: true, force: true });
  }
}

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── phaseLedgerBlocked truth table ─────────────────────────────────────────

describe('phase-ledger: phaseLedgerBlocked (GH-696)', () => {
  beforeEach(clearTicketDir);

  it('maps brief/spec/tasks to their ledger files with terminal "done"', () => {
    assert.equal(STEP_LEDGERS.brief.file, 'brief-phase.json');
    assert.equal(STEP_LEDGERS.spec.file, 'spec-phase.json');
    assert.equal(STEP_LEDGERS.tasks.file, 'tasks-phase.json');
    for (const step of ['brief', 'spec', 'tasks']) {
      assert.equal(STEP_LEDGERS[step].terminal, 'done');
    }
  });

  it('absent ledger file → not blocked (legacy/pre-phase-driver tickets)', () => {
    for (const step of ['brief', 'spec', 'tasks']) {
      assert.deepEqual(phaseLedgerBlocked(ticketDir, step), {
        blocked: false,
        currentPhase: null,
      });
    }
  });

  it('non-terminal currentPhase → blocked, phase surfaced', () => {
    writeLedger('brief-phase.json', 'draft');
    assert.deepEqual(phaseLedgerBlocked(ticketDir, 'brief'), {
      blocked: true,
      currentPhase: 'draft',
    });
    writeLedger('spec-phase.json', 'surface_audit');
    assert.deepEqual(phaseLedgerBlocked(ticketDir, 'spec'), {
      blocked: true,
      currentPhase: 'surface_audit',
    });
    writeLedger('tasks-phase.json', 'requirements_extract');
    assert.deepEqual(phaseLedgerBlocked(ticketDir, 'tasks'), {
      blocked: true,
      currentPhase: 'requirements_extract',
    });
  });

  it('terminal currentPhase "done" → not blocked', () => {
    for (const [step, file] of [
      ['brief', 'brief-phase.json'],
      ['spec', 'spec-phase.json'],
      ['tasks', 'tasks-phase.json'],
    ]) {
      writeLedger(file, 'done');
      assert.deepEqual(phaseLedgerBlocked(ticketDir, step), {
        blocked: false,
        currentPhase: 'done',
      });
    }
  });

  it('corrupt ledger JSON → blocked with currentPhase UNPARSEABLE_PHASE (fail closed; repair: operator escalation — the plan matrix asks the user to delete/restore the ledger, PR #718)', () => {
    fs.writeFileSync(path.join(ticketDir, 'brief-phase.json'), '{not json', 'utf-8');
    assert.deepEqual(phaseLedgerBlocked(ticketDir, 'brief'), {
      blocked: true,
      currentPhase: UNPARSEABLE_PHASE,
    });
    assert.equal(UNPARSEABLE_PHASE, 'unparseable'); // sentinel pinned — steps key on it
  });

  it('parseable ledger without a string currentPhase → blocked "unparseable" (refusal to vouch)', () => {
    fs.writeFileSync(path.join(ticketDir, 'spec-phase.json'), JSON.stringify({}), 'utf-8');
    assert.deepEqual(phaseLedgerBlocked(ticketDir, 'spec'), {
      blocked: true,
      currentPhase: 'unparseable',
    });
  });

  it('steps without a registered ledger → never blocked (map-driven)', () => {
    assert.deepEqual(phaseLedgerBlocked(ticketDir, 'pr'), { blocked: false, currentPhase: null });
  });
});

// ─── Step verifiers consume the predicate ───────────────────────────────────

describe('phase-ledger: step verifiers refuse mid-flight ledgers (GH-696)', () => {
  const v = createStepVerifiers({ TASKS_BASE: tmpRoot, safeTicketPath: (id) => id, workRoot });

  beforeEach(clearTicketDir);

  const MATRIX = [
    ['verifyBrief', 'brief.md', 'brief-phase.json', 'draft'],
    ['verifySpec', 'spec.md', 'spec-phase.json', 'surface_audit'],
    ['verifyTasks', 'tasks.md', 'tasks-phase.json', 'draft'],
  ];

  for (const [verifier, artifact, ledgerFile, midPhase] of MATRIX) {
    it(`${verifier}: artifact + no ledger → true (regression: legacy tickets advance as today)`, () => {
      fs.writeFileSync(path.join(ticketDir, artifact), '# content\n', 'utf-8');
      assert.equal(v[verifier](ticketId), true);
    });

    it(`${verifier}: artifact + ${ledgerFile} at "${midPhase}" → false (mid-flight)`, () => {
      fs.writeFileSync(path.join(ticketDir, artifact), '# content\n', 'utf-8');
      writeLedger(ledgerFile, midPhase);
      assert.equal(v[verifier](ticketId), false);
    });

    it(`${verifier}: artifact + ${ledgerFile} at "done" → true`, () => {
      fs.writeFileSync(path.join(ticketDir, artifact), '# content\n', 'utf-8');
      writeLedger(ledgerFile, 'done');
      assert.equal(v[verifier](ticketId), true);
    });

    it(`${verifier}: artifact + corrupt ${ledgerFile} → false (fail closed; repair: operator escalation via the plan matrix, PR #718)`, () => {
      fs.writeFileSync(path.join(ticketDir, artifact), '# content\n', 'utf-8');
      fs.writeFileSync(path.join(ticketDir, ledgerFile), '{not json', 'utf-8');
      assert.equal(v[verifier](ticketId), false);
    });

    it(`${verifier}: missing artifact → false regardless of ledger`, () => {
      writeLedger(ledgerFile, 'done');
      assert.equal(v[verifier](ticketId), false);
    });
  }

  it('does not consult sibling ledgers (brief ignores spec-phase.json)', () => {
    fs.writeFileSync(path.join(ticketDir, 'brief.md'), '# content\n', 'utf-8');
    writeLedger('spec-phase.json', 'surface_audit');
    assert.equal(v.verifyBrief(ticketId), true);
  });
});

// ─── Gate verifiers consume the predicate ───────────────────────────────────

describe('phase-ledger: gate verifiers refuse mid-flight ledgers (GH-696)', () => {
  const g = createGateVerifiers({
    TASKS_BASE: tmpRoot,
    safeTicketPath: (id) => id,
    resolveGitHead: () => 'ref: refs/heads/stub',
    workRoot,
  });

  beforeEach(clearTicketDir);

  function writePassingBrief() {
    fs.writeFileSync(path.join(ticketDir, 'brief.md'), '# Brief\n\nNo open questions.\n', 'utf-8');
  }

  function writePassingSpec() {
    fs.writeFileSync(path.join(ticketDir, 'spec.md'), '# Spec\n', 'utf-8');
    fs.writeFileSync(
      path.join(ticketDir, 'gherkin.feature'),
      '<!-- gherkin-skip: test fixture -->\nFeature: F\n  Scenario: S\n    Given g\n    When w\n    Then t\n',
      'utf-8'
    );
  }

  it('verifyBriefGate: valid brief + no ledger → true (regression)', () => {
    writePassingBrief();
    assert.equal(g.verifyBriefGate(ticketId), true);
  });

  it('verifyBriefGate: valid brief + brief-phase.json at "draft" → false (GH-689 window pin)', () => {
    writePassingBrief();
    writeLedger('brief-phase.json', 'draft');
    assert.equal(g.verifyBriefGate(ticketId), false);
  });

  it('verifyBriefGate: valid brief + brief-phase.json at "done" → true', () => {
    writePassingBrief();
    writeLedger('brief-phase.json', 'done');
    assert.equal(g.verifyBriefGate(ticketId), true);
  });

  it('verifyBriefGate: corrupt brief-phase.json → false (fail closed)', () => {
    writePassingBrief();
    fs.writeFileSync(path.join(ticketDir, 'brief-phase.json'), '{not json', 'utf-8');
    assert.equal(g.verifyBriefGate(ticketId), false);
  });

  it('verifySpecGate: valid spec + no ledger → true (regression)', () => {
    writePassingSpec();
    assert.equal(g.verifySpecGate(ticketId), true);
  });

  it('verifySpecGate: valid spec + spec-phase.json at "surface_audit" → false (GH-689 window pin)', () => {
    writePassingSpec();
    writeLedger('spec-phase.json', 'surface_audit');
    assert.equal(g.verifySpecGate(ticketId), false);
  });

  it('verifySpecGate: valid spec + spec-phase.json at "done" → true', () => {
    writePassingSpec();
    writeLedger('spec-phase.json', 'done');
    assert.equal(g.verifySpecGate(ticketId), true);
  });

  it('verifySpecGate: corrupt spec-phase.json → false (fail closed)', () => {
    writePassingSpec();
    fs.writeFileSync(path.join(ticketDir, 'spec-phase.json'), '{not json', 'utf-8');
    assert.equal(g.verifySpecGate(ticketId), false);
  });
});

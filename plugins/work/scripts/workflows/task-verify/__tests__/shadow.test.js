'use strict';

/**
 * Shadow-mode tests (GH-755): the verifier observes a real boundary, logs
 * verdict + incumbent + divergence to the audit trail, has zero authority,
 * and never throws into the gate. WORK_TDD_MODE gating included.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { maybeRunShadow, computeDivergence, shadowEnabled } = require('../shadow');
const { VERDICTS } = require('../../lib/outcome-verdicts');

let ROOT;
let REPO;
let TASKS_DIR;
let baseSha;

function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'task-verify-shadow-'));
  REPO = path.join(ROOT, 'repo');
  TASKS_DIR = path.join(ROOT, 'tasks', 'TEST-SHADOW-1');
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  fs.writeFileSync(
    path.join(REPO, 'package.json'),
    JSON.stringify({ name: 't', scripts: { test: 'node --test' } })
  );
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'src/mod.js'), 'module.exports = () => 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  baseSha = git(['rev-parse', 'HEAD']);

  // The "task": a docs change (keeps the run fast; no test execution).
  fs.writeFileSync(path.join(REPO, 'README.md'), '# docs\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'task 1: docs']);

  fs.writeFileSync(path.join(TASKS_DIR, '.last-commit-sha'), baseSha);
  fs.writeFileSync(
    path.join(TASKS_DIR, 'tasks.md'),
    [
      '## Task 1 — Write the readme',
      '### Type',
      'docs',
      '### Files in scope',
      '- README.md',
      '',
    ].join('\n')
  );
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function collectingAudit() {
  const rows = [];
  return {
    rows,
    appendAudit: (ticket, entry) => rows.push({ ticket, ...entry }),
  };
}

describe('task-verify shadow mode (GH-755)', () => {
  it('is a no-op unless WORK_TDD_MODE=shadow', () => {
    const audit = collectingAudit();
    const result = maybeRunShadow(
      { safeName: 'TEST-SHADOW-1', tasksDir: TASKS_DIR, taskNum: 1, taskType: 'docs' },
      { env: { WORK_TDD_MODE: 'process' }, appendAudit: audit.appendAudit }
    );
    assert.equal(result, null);
    assert.equal(audit.rows.length, 0);
    assert.equal(shadowEnabled({ WORK_TDD_MODE: 'shadow' }), true);
    assert.equal(shadowEnabled({}), false);
  });

  it('observes a real boundary and audits verdict + incumbent + divergence', () => {
    const audit = collectingAudit();
    const result = maybeRunShadow(
      {
        safeName: 'TEST-SHADOW-1',
        tasksDir: TASKS_DIR,
        taskNum: 1,
        taskType: 'docs',
        incumbent: 'advance',
        repoDir: REPO,
      },
      { env: { WORK_TDD_MODE: 'shadow' }, appendAudit: audit.appendAudit }
    );

    assert.equal(result.verdict, VERDICTS.verified, result.reasons.join(' | '));
    assert.equal(audit.rows.length, 1);
    const row = audit.rows[0];
    assert.equal(row.action, 'task-verify-shadow');
    assert.equal(row.allow, true, 'shadow has zero authority');
    assert.equal(row.task, 1);
    assert.equal(row.meta.incumbent, 'advance');
    assert.equal(row.meta.verdict, VERDICTS.verified);
    assert.equal(row.meta.divergence, 'agree');
  });

  it('records divergence when the incumbent blocked clean work', () => {
    const audit = collectingAudit();
    const result = maybeRunShadow(
      {
        safeName: 'TEST-SHADOW-1',
        tasksDir: TASKS_DIR,
        taskNum: 1,
        taskType: 'docs',
        incumbent: 'blocked',
        repoDir: REPO,
      },
      { env: { WORK_TDD_MODE: 'shadow' }, appendAudit: audit.appendAudit }
    );
    assert.equal(result.verdict, VERDICTS.verified);
    assert.equal(audit.rows[0].meta.divergence, 'shadow-looser');
  });

  it('divergence taxonomy is total', () => {
    assert.equal(computeDivergence('advance', VERDICTS.contradicted), 'shadow-stricter');
    assert.equal(computeDivergence('blocked', VERDICTS.unverified), 'shadow-looser');
    assert.equal(computeDivergence('blocked', VERDICTS.contradicted), 'agree');
    assert.equal(computeDivergence('advance', VERDICTS.verified), 'agree');
  });

  it('internal failures audit an error row and never throw into the gate', () => {
    const audit = collectingAudit();
    const result = maybeRunShadow(
      {
        safeName: 'TEST-SHADOW-1',
        tasksDir: path.join(ROOT, 'nonexistent'),
        taskNum: 1,
        taskType: 'docs',
        incumbent: 'advance',
        repoDir: path.join(ROOT, 'not-a-repo'),
      },
      { env: { WORK_TDD_MODE: 'shadow' }, appendAudit: audit.appendAudit }
    );
    assert.equal(result, null);
    assert.equal(audit.rows.length, 1);
    assert.match(audit.rows[0].action, /task-verify-shadow-error/);
  });
});

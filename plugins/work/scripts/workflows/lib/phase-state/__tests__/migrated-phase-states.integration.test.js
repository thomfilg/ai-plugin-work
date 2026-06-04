'use strict';

/**
 * Integration tests for the migration of the 11 remaining
 * `*-phase-state.js` files (GH-478 Task 8).
 *
 * Each of these files must collapse to a thin wrapper around
 * `createPhaseStateCli` while preserving:
 *   - the on-disk state-file shape and key order
 *     (`{ ticket, createdAt, updatedAt, currentPhase, phases }`)
 *   - their public re-exports (`PHASES`, `<workflow>CanTransition`,
 *     `<workflow>NextPhases`)
 *   - token-gating behavior (where it existed)
 *   - path-traversal rejection
 *
 * The test spawns each `*-phase-state.js` as a child process against a
 * temporary `TASKS_BASE`, minting tokens the same way the production
 * hook does for the gated scripts.
 *
 * These tests are designed to fail until each migration is complete:
 * the structural check (`createPhaseStateCli(` must appear) gives us a
 * deterministic signal that the factory is wired up; the round-trip
 * and security tests prove the wrapper preserves behavior.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOKEN_DIR = '/tmp/.claude-write-tokens';
const { tokenPath } = require('../../scripts/write-report');

const WORKFLOWS_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Per-file migration descriptor.
 *
 *   scriptPath:      absolute path to the *-phase-state.js file
 *   basename:        file basename used for token lookup
 *   allowedAgent:    agent name to mint the token under (null = unguarded, no token needed)
 *   stateFile:       expected on-disk JSON basename
 *   initialPhase:    expected `state.currentPhase` after `init`
 *   secondPhase:     a valid target for `transition` from initialPhase
 *   exports:         expected public export names from `module.exports`
 *   transitionFnExportName: which export holds the canTransition function
 *   nextFnExportName:       which export holds the nextPhases function
 */
const MIGRATIONS = [
  {
    workflow: 'brief',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-brief', 'brief-phase-state.js'),
    basename: 'brief-phase-state.js',
    allowedAgent: 'brief-writer',
    stateFile: 'brief-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'overlap',
    exports: ['PHASES', 'briefCanTransition', 'briefNextPhases'],
    transitionFnExportName: 'briefCanTransition',
    nextFnExportName: 'briefNextPhases',
  },
  {
    workflow: 'spec',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-spec', 'spec-phase-state.js'),
    basename: 'spec-phase-state.js',
    allowedAgent: 'spec-writer',
    stateFile: 'spec-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'reuse_audit',
    exports: ['PHASES', 'specCanTransition', 'specNextPhases'],
    transitionFnExportName: 'specCanTransition',
    nextFnExportName: 'specNextPhases',
  },
  {
    workflow: 'code',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-code-checker', 'code-phase-state.js'),
    basename: 'code-phase-state.js',
    allowedAgent: 'code-checker',
    stateFile: 'code-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'change_classify',
    exports: ['PHASES', 'codeCanTransition', 'codeNextPhases'],
    transitionFnExportName: 'codeCanTransition',
    nextFnExportName: 'codeNextPhases',
  },
  {
    workflow: 'qa',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-qa-feature-tester', 'qa-phase-state.js'),
    basename: 'qa-phase-state.js',
    allowedAgent: 'qa-feature-tester',
    stateFile: 'qa-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'env_setup',
    exports: ['PHASES', 'qaCanTransition', 'qaNextPhases'],
    transitionFnExportName: 'qaCanTransition',
    nextFnExportName: 'qaNextPhases',
  },
  {
    workflow: 'reports',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-reports', 'reports-phase-state.js'),
    basename: 'reports-phase-state.js',
    allowedAgent: 'reports-writer',
    stateFile: 'reports-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'collect_artifacts',
    exports: ['PHASES', 'reportsCanTransition', 'reportsNextPhases'],
    transitionFnExportName: 'reportsCanTransition',
    nextFnExportName: 'reportsNextPhases',
  },
  {
    workflow: 'pr-review',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-pr-reviewer', 'pr-review-phase-state.js'),
    basename: 'pr-review-phase-state.js',
    allowedAgent: 'pr-reviewer',
    stateFile: 'pr-review-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'pr_context',
    exports: ['PHASES', 'prReviewCanTransition', 'prReviewNextPhases'],
    transitionFnExportName: 'prReviewCanTransition',
    nextFnExportName: 'prReviewNextPhases',
  },
  {
    workflow: 'cleanup',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-cleanup', 'cleanup-phase-state.js'),
    basename: 'cleanup-phase-state.js',
    allowedAgent: 'cleanup-runner',
    stateFile: 'cleanup-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'pr_merged_check',
    exports: ['PHASES', 'cleanupCanTransition', 'cleanupNextPhases'],
    transitionFnExportName: 'cleanupCanTransition',
    nextFnExportName: 'cleanupNextPhases',
  },
  {
    workflow: 'pr',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-pr-step', 'pr-phase-state.js'),
    basename: 'pr-phase-state.js',
    allowedAgent: 'pr-generator',
    stateFile: 'pr-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'diff_audit',
    exports: ['PHASES', 'prCanTransition', 'prNextPhases'],
    transitionFnExportName: 'prCanTransition',
    nextFnExportName: 'prNextPhases',
  },
  {
    workflow: 'completion',
    scriptPath: path.join(
      WORKFLOWS_ROOT,
      'work-completion-checker',
      'completion-phase-state.js'
    ),
    basename: 'completion-phase-state.js',
    allowedAgent: 'completion-checker',
    stateFile: 'completion-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'requirements_extract',
    exports: ['PHASES', 'completionCanTransition', 'completionNextPhases'],
    transitionFnExportName: 'completionCanTransition',
    nextFnExportName: 'completionNextPhases',
  },
  {
    workflow: 'task-review',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-task-review', 'task-review-phase-state.js'),
    basename: 'task-review-phase-state.js',
    allowedAgent: 'task-reviewer',
    stateFile: 'task-review-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'diff_audit',
    exports: ['PHASES', 'taskReviewCanTransition', 'taskReviewNextPhases'],
    transitionFnExportName: 'taskReviewCanTransition',
    nextFnExportName: 'taskReviewNextPhases',
  },
  {
    workflow: 'ci',
    scriptPath: path.join(WORKFLOWS_ROOT, 'work-ci', 'ci-phase-state.js'),
    basename: 'ci-phase-state.js',
    // ci-phase-state.js is unguarded (no token-gating, see workflow-definition.js
    // comment: "ci-next.js / ci-phase-state.js intentionally NOT agent-gated.")
    allowedAgent: null,
    stateFile: 'ci-phase.json',
    initialPhase: 'inputs',
    secondPhase: 'wait',
    exports: ['PHASES', 'ciCanTransition', 'ciNextPhases'],
    transitionFnExportName: 'ciCanTransition',
    nextFnExportName: 'ciNextPhases',
  },
];

function mintToken(basename, ticketId, opts = {}) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const tp = tokenPath(basename, ticketId);
  const payload = {
    agent: opts.agent || 'unset-agent',
    timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : Date.now(),
    tasksBase: null,
  };
  fs.writeFileSync(tp, JSON.stringify(payload), { mode: 0o600 });
  return tp;
}

function clearToken(basename, ticketId) {
  for (const tp of [tokenPath(basename, ticketId), tokenPath(basename)]) {
    try {
      fs.unlinkSync(tp);
    } catch {
      /* ignore */
    }
  }
}

function run(scriptPath, args, env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      TASKS_BASE: env.TASKS_BASE,
    },
  });
}

for (const m of MIGRATIONS) {
  describe(`${m.basename} (factory delegator)`, () => {
    let tmp;
    let tasksBase;
    const ticket = `GH-99${m.workflow.replace(/[^a-z0-9]/gi, '').slice(0, 4).padEnd(4, '0')}`;

    before(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), `migrated-${m.workflow}-`));
      tasksBase = path.join(tmp, 'tasks');
      fs.mkdirSync(path.join(tasksBase, ticket), { recursive: true });
    });

    after(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
      clearToken(m.basename, ticket);
    });

    beforeEach(() => {
      const stateFile = path.join(tasksBase, ticket, m.stateFile);
      try {
        fs.unlinkSync(stateFile);
      } catch {
        /* ignore */
      }
      clearToken(m.basename, ticket);
    });

    it('source file delegates to createPhaseStateCli factory', () => {
      const src = fs.readFileSync(m.scriptPath, 'utf8');
      assert.match(
        src,
        /createPhaseStateCli\s*\(/,
        `${m.basename} must contain a createPhaseStateCli( call`
      );
    });

    it('preserves public re-exports', () => {
      delete require.cache[m.scriptPath];
      const mod = require(m.scriptPath);
      for (const exp of m.exports) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(mod, exp),
          `${m.basename} must export "${exp}"`
        );
      }
      assert.ok(Array.isArray(mod.PHASES), 'PHASES must be an array');
      assert.ok(
        mod.PHASES.includes(m.initialPhase),
        `PHASES must include "${m.initialPhase}"`
      );
      assert.ok(mod.PHASES.includes('done'), 'PHASES must include "done"');
      assert.equal(typeof mod[m.transitionFnExportName], 'function');
      assert.equal(typeof mod[m.nextFnExportName], 'function');
      assert.equal(
        mod[m.transitionFnExportName](m.initialPhase, m.secondPhase),
        true,
        `${m.transitionFnExportName}("${m.initialPhase}", "${m.secondPhase}") must be true`
      );
      assert.equal(
        mod[m.transitionFnExportName](m.initialPhase, 'done'),
        false,
        `${m.transitionFnExportName}("${m.initialPhase}", "done") must be false`
      );
    });

    it('init → record → transition round-trip preserves baseline JSON shape and key order', () => {
      // INIT
      if (m.allowedAgent) mintToken(m.basename, ticket, { agent: m.allowedAgent });
      const initRes = run(m.scriptPath, ['init', ticket], { TASKS_BASE: tasksBase });
      assert.equal(initRes.status, 0, `init failed for ${m.basename}: ${initRes.stderr}`);
      const initOut = JSON.parse(initRes.stdout.trim());
      assert.equal(initOut.ok, true);
      assert.equal(initOut.status, 'created');
      assert.deepEqual(Object.keys(initOut.state), [
        'ticket',
        'createdAt',
        'updatedAt',
        'currentPhase',
        'phases',
      ]);
      assert.equal(initOut.state.ticket, ticket);
      assert.equal(initOut.state.currentPhase, m.initialPhase);
      assert.deepEqual(initOut.state.phases, {});

      // RECORD initial phase
      if (m.allowedAgent) mintToken(m.basename, ticket, { agent: m.allowedAgent });
      const recRes = run(
        m.scriptPath,
        ['record', ticket, m.initialPhase, '--summary', `did ${m.initialPhase}`],
        { TASKS_BASE: tasksBase }
      );
      assert.equal(recRes.status, 0, `record failed for ${m.basename}: ${recRes.stderr}`);
      const recOut = JSON.parse(recRes.stdout.trim());
      assert.equal(recOut.ok, true);
      assert.equal(recOut.recordedPhase, m.initialPhase);
      assert.equal(recOut.state.phases[m.initialPhase].summary, `did ${m.initialPhase}`);
      assert.equal(typeof recOut.state.phases[m.initialPhase].completedAt, 'string');

      // TRANSITION initial → second
      if (m.allowedAgent) mintToken(m.basename, ticket, { agent: m.allowedAgent });
      const trRes = run(m.scriptPath, ['transition', ticket, m.secondPhase], {
        TASKS_BASE: tasksBase,
      });
      assert.equal(trRes.status, 0, `transition failed for ${m.basename}: ${trRes.stderr}`);
      const trOut = JSON.parse(trRes.stdout.trim());
      assert.equal(trOut.ok, true);
      assert.equal(trOut.currentPhase, m.secondPhase);

      // CURRENT (un-gated)
      const curRes = run(m.scriptPath, ['current', ticket], { TASKS_BASE: tasksBase });
      assert.equal(curRes.status, 0, `current failed for ${m.basename}: ${curRes.stderr}`);
      const curOut = JSON.parse(curRes.stdout.trim());
      assert.equal(curOut.ok, true);
      assert.equal(curOut.currentPhase, m.secondPhase);
      assert.deepEqual(Object.keys(curOut.state), [
        'ticket',
        'createdAt',
        'updatedAt',
        'currentPhase',
        'phases',
      ]);

      // On-disk file matches the captured baseline shape (atomic write preserved).
      const stateFile = path.join(tasksBase, ticket, m.stateFile);
      const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.deepEqual(Object.keys(onDisk), [
        'ticket',
        'createdAt',
        'updatedAt',
        'currentPhase',
        'phases',
      ]);
      assert.equal(onDisk.currentPhase, m.secondPhase);
      assert.equal(onDisk.phases[m.initialPhase].summary, `did ${m.initialPhase}`);
    });

    if (m.allowedAgent) {
      it('rejects an expired write token', () => {
        mintToken(m.basename, ticket, { agent: m.allowedAgent });
        run(m.scriptPath, ['init', ticket], { TASKS_BASE: tasksBase });

        mintToken(m.basename, ticket, {
          agent: m.allowedAgent,
          timestamp: Date.now() - 60_000,
        });
        const res = run(m.scriptPath, ['record', ticket, m.initialPhase], {
          TASKS_BASE: tasksBase,
        });
        assert.notEqual(res.status, 0, `expected non-zero exit for expired token (${m.basename})`);
        const err = JSON.parse(res.stderr.trim().split('\n').pop());
        assert.equal(err.error, true);
        assert.match(err.message, /expired/i);
      });

      it('rejects an unauthorized agent', () => {
        mintToken(m.basename, ticket, { agent: m.allowedAgent });
        run(m.scriptPath, ['init', ticket], { TASKS_BASE: tasksBase });

        mintToken(m.basename, ticket, { agent: 'someone-else' });
        const res = run(m.scriptPath, ['record', ticket, m.initialPhase], {
          TASKS_BASE: tasksBase,
        });
        assert.notEqual(
          res.status,
          0,
          `expected non-zero exit for unauthorized agent (${m.basename})`
        );
        const err = JSON.parse(res.stderr.trim().split('\n').pop());
        assert.equal(err.error, true);
        assert.match(err.message, /not authorized/i);
      });
    }

    it('rejects a path-traversal ticket id', () => {
      if (m.allowedAgent) mintToken(m.basename, '../etc', { agent: m.allowedAgent });
      const res = run(m.scriptPath, ['init', '../etc'], { TASKS_BASE: tasksBase });
      assert.notEqual(res.status, 0, `expected non-zero exit for path-traversal (${m.basename})`);
      const err = JSON.parse(res.stderr.trim().split('\n').pop());
      assert.equal(err.error, true);
      assert.match(err.message, /Invalid ticket ID/i);
      clearToken(m.basename, '../etc');
    });
  });
}

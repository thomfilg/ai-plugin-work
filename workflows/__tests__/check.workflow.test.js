/**
 * Tests for check.workflow.js
 *
 * Covers: exports, params(), inspect(), detectStepState(), transition graph.
 * Uses node:test + node:assert/strict.
 * Run: node --test workflows/__tests__/check.workflow.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'check.workflow.js');

describe('check.workflow.js', () => {
  const wf = require(WORKFLOW_PATH);

  // ─── Exports ────────────────────────────────────────────────────────

  describe('exports', () => {
    it('exports name, command, stateDir, steps, transitions', () => {
      assert.equal(wf.name, 'check');
      assert.equal(wf.command, '/check');
      assert.ok(wf.stateDir);
      assert.ok(Array.isArray(wf.steps));
      assert.ok(Array.isArray(wf.transitions));
    });
  });

  // ─── params() ──────────────────────────────────────────────────────

  describe('params()', () => {
    it('parses ticket ID from args', () => {
      const p = wf.params('PROJ-856');
      assert.equal(p.ticketId, 'PROJ-856');
      assert.equal(p.instanceId, 'PROJ-856');
    });

    it('prefixes numeric IDs with project key', () => {
      const p = wf.params('856');
      assert.ok(p.ticketId.endsWith('-856'));
      assert.equal(p.instanceId, p.ticketId);
    });

    it('uppercases ticket ID', () => {
      const p = wf.params('proj-123');
      assert.equal(p.ticketId, 'PROJ-123');
    });

    it('falls back to branch name when args are empty', () => {
      const p = wf.params('');
      // Should return something (branch name or "UNKNOWN"), never empty
      assert.ok(p.ticketId);
      assert.equal(p.instanceId, p.ticketId);
    });
  });

  // ─── inspect() ─────────────────────────────────────────────────────

  describe('inspect()', () => {
    it('returns changesHash and report presence data', () => {
      // Use a non-existent instanceId so no files exist on disk
      const data = wf.inspect('__TEST_NONEXISTENT_ID__');

      // changesHash is always present
      assert.ok(typeof data.changesHash === 'string');
      assert.ok(data.changesHash.length > 0);

      // reportFolder is always present
      assert.ok(typeof data.reportFolder === 'string');

      // boolean fields
      assert.equal(typeof data.reportFolderExists, 'boolean');
      assert.equal(typeof data.readmeExists, 'boolean');
      assert.equal(typeof data.readmeHashMatch, 'boolean');

      // reports object
      assert.ok(typeof data.reports === 'object');

      // impactedApps is an array
      assert.ok(Array.isArray(data.impactedApps));

      // allPhase1ReportsMatch is boolean
      assert.equal(typeof data.allPhase1ReportsMatch, 'boolean');
    });

    it('returns hasWebApps as a boolean', () => {
      const data = wf.inspect('__TEST_NONEXISTENT_ID__');
      assert.equal(typeof data.hasWebApps, 'boolean');
    });
  });

  // ─── detectStepState() ─────────────────────────────────────────────

  describe('detectStepState()', () => {
    // Helper to build inspect data with defaults
    function makeInspect(overrides = {}) {
      return {
        reportFolder: '/tmp/__test__',
        reportFolderExists: false,
        changesHash: 'aabbccddee11',
        impactedApps: [],
        hasBackendChanges: false,
        readmeExists: false,
        readmeHashMatch: false,
        reports: {
          'code-review.check.md': { exists: false, hashMatch: false },
          'tests.check.md': { exists: false, hashMatch: false },
          'completion.check.md': { exists: false, hashMatch: false },
        },
        qaReports: {},
        apiReport: { exists: false, hashMatch: false },
        codeReviewHasSuggestions: false,
        replyExists: false,
        replyHashMatch: false,
        consensusLogExists: false,
        replyHasImplementations: false,
        missingReports: ['code-review.check.md', 'tests.check.md', 'completion.check.md'],
        allPhase1ReportsMatch: false,
        ...overrides,
      };
    }

    it('returns SKIP when cache hash matches (readmeHashMatch=true)', () => {
      const r = wf.detectStepState('2_start_env', 'X-1', null, makeInspect({
        readmeHashMatch: true,
      }));
      assert.equal(r.action, 'SKIP');
      assert.match(r.reason, /Cache valid/i);
    });

    it('returns RUN when hash mismatch (readmeHashMatch=false)', () => {
      const r = wf.detectStepState('2_start_env', 'X-1', null, makeInspect({
        readmeHashMatch: false,
      }));
      assert.equal(r.action, 'RUN');
    });

    it('1_setup always RUN', () => {
      const r = wf.detectStepState('1_setup', 'X-1', null, makeInspect());
      assert.equal(r.action, 'RUN');
    });

    it('4_phase1_agents: SKIP when all reports match', () => {
      const r = wf.detectStepState('4_phase1_agents', 'X-1', null, makeInspect({
        allPhase1ReportsMatch: true,
        missingReports: [],
      }));
      assert.equal(r.action, 'SKIP');
    });

    it('4_phase1_agents: RUN when reports are missing', () => {
      const r = wf.detectStepState('4_phase1_agents', 'X-1', null, makeInspect({
        allPhase1ReportsMatch: false,
        missingReports: ['code-review.check.md'],
      }));
      assert.equal(r.action, 'RUN');
    });

    it('8_output always RUN', () => {
      const r = wf.detectStepState('8_output', 'X-1', null, makeInspect());
      assert.equal(r.action, 'RUN');
    });

    it('unknown step defaults to RUN', () => {
      const r = wf.detectStepState('99_unknown', 'X-1', null, makeInspect());
      assert.equal(r.action, 'RUN');
    });

    // ─── GH-120: Skip Playwright when no web apps ───────────────────

    it('3_verify_playwright: SKIP when hasWebApps=false and cache invalid', () => {
      const r = wf.detectStepState('3_verify_playwright', 'X-1', null, makeInspect({
        readmeHashMatch: false,
        hasWebApps: false,
      }));
      assert.equal(r.action, 'SKIP');
      assert.match(r.reason, /no web apps/i);
    });

    it('3_verify_playwright: RUN when hasWebApps=true and cache invalid', () => {
      const r = wf.detectStepState('3_verify_playwright', 'X-1', null, makeInspect({
        readmeHashMatch: false,
        hasWebApps: true,
      }));
      assert.equal(r.action, 'RUN');
    });

    it('3_verify_playwright: defaults to RUN when inspectData is null', () => {
      const r = wf.detectStepState('3_verify_playwright', 'X-1', null, null);
      assert.equal(r.action, 'RUN');
    });
  });

  // ---------------------------------------------------------------------------
  // ─── Transition Graph ──────────────────────────────────────────────

  describe('transitions', () => {
    const transitionMap = {};
    for (const t of wf.transitions) {
      transitionMap[t.source] = t.targets;
    }
    const stepIds = wf.steps.map(s => s.id);

    it('all steps are reachable from step 1', () => {
      function reachable(start) {
        const visited = new Set();
        const queue = [start];
        while (queue.length > 0) {
          const current = queue.shift();
          if (visited.has(current)) continue;
          visited.add(current);
          for (const next of (transitionMap[current] || [])) {
            queue.push(next);
          }
        }
        return visited;
      }

      const reached = reachable(stepIds[0]);
      for (const id of stepIds) {
        assert.ok(reached.has(id), `Step ${id} is not reachable from ${stepIds[0]}`);
      }
    });

    it('no self-transitions', () => {
      for (const t of wf.transitions) {
        assert.ok(
          !t.targets.includes(t.source),
          `Step ${t.source} has a self-transition`
        );
      }
    });

    it('terminal state has empty targets', () => {
      const lastStepId = stepIds[stepIds.length - 1];
      const t = wf.transitions.find(tr => tr.source === lastStepId);
      assert.ok(t, `No transition entry for terminal step ${lastStepId}`);
      assert.deepEqual(t.targets, []);
    });

    // ─── GH-120: Skip edge from 2_start_env to 4_phase1_agents ──────

    it('2_start_env can transition to both 3_verify_playwright and 4_phase1_agents', () => {
      const t = wf.transitions.find(tr => tr.source === '2_start_env');
      assert.ok(t, 'No transition entry for 2_start_env');
      assert.ok(t.targets.includes('3_verify_playwright'), 'Missing target: 3_verify_playwright');
      assert.ok(t.targets.includes('4_phase1_agents'), 'Missing target: 4_phase1_agents');
    });

    it('no orphaned steps — every step ID appears as a source or target in transitions', () => {
      const allReferenced = new Set();
      for (const t of wf.transitions) {
        allReferenced.add(t.source);
        for (const target of t.targets) {
          allReferenced.add(target);
        }
      }
      for (const id of stepIds) {
        assert.ok(
          allReferenced.has(id),
          `Step ${id} is orphaned — not referenced in any transition`
        );
      }
    });
  });
});

'use strict';

/**
 * Verdict-table liveness test (GH-754, outcome-verification Phase 1.3).
 *
 * Liveness is a provable invariant, not a bug-fixing goal: every BLOCK
 * verdict the implement machinery can produce must carry at least one
 * sanctioned exit edge, and every edge's mechanism must actually exist.
 * A wedge (block with no legal move) is a CI failure here — before and after
 * the outcome-mode flip.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  BLOCK_VERDICTS,
  EXIT_EDGES,
  findLivenessViolations,
  gateRejectionActionsFromSource,
} = require('../verdict-table');

describe('verdict-table liveness (GH-754)', () => {
  it('every BLOCK verdict names at least one known exit edge', () => {
    assert.deepEqual(findLivenessViolations(), []);
  });

  it('every exit edge mechanism exists in the codebase', () => {
    for (const [name, edge] of Object.entries(EXIT_EDGES)) {
      assert.equal(typeof edge.verify, 'function', `${name}: edge must carry a verify()`);
      assert.equal(edge.verify(), true, `${name}: mechanism missing — ${edge.mechanism}`);
      assert.ok(edge.mechanism, `${name}: edge must document its mechanism`);
    }
  });

  it('covers every gate-rejection action the gate source can emit (no drift)', () => {
    const emitted = gateRejectionActionsFromSource();
    assert.ok(
      emitted.length >= 6,
      `expected >= 6 rejection kinds in source, got ${emitted.length}`
    );
    const tableIds = new Set(BLOCK_VERDICTS.map((v) => v.id));
    const missing = emitted.filter((action) => !tableIds.has(action));
    assert.deepEqual(
      missing,
      [],
      `gate-rejections.js emits verdicts absent from the table: ${missing.join(', ')} — ` +
        'a new rejection kind may not ship without declaring its exit edge'
    );
  });

  it('the escalate edge exposes all three recovery actions', () => {
    const { RECOVER_ACTIONS } = require('../../../../work-state/recover');
    assert.deepEqual(RECOVER_ACTIONS, ['abandon-cycle', 'resync-meta', 'reopen-task']);
  });

  it('goes red on a deliberately edge-less verdict (negative fixture)', () => {
    const poisoned = [
      ...BLOCK_VERDICTS,
      { id: 'test-edge-less-verdict', source: 'test', exits: [] },
    ];
    const violations = findLivenessViolations(poisoned);
    assert.equal(violations.length, 1);
    assert.match(violations[0], /test-edge-less-verdict.*NO exit edge/);

    const unknownExit = [{ id: 'test-unknown-exit', source: 'test', exits: ['teleport'] }];
    assert.match(findLivenessViolations(unknownExit)[0], /unknown exit edge "teleport"/);
  });

  it('historical wedge states are all mapped to the escalate hatch', () => {
    // The GH-721/722/724/736 wedge classes must each resolve via recover.
    const wedgeIds = [
      'tasks-meta-desynced',
      'completed-task-carries-defect',
      'stuck-cycle-no-legal-phase',
    ];
    for (const id of wedgeIds) {
      const verdict = BLOCK_VERDICTS.find((v) => v.id === id);
      assert.ok(verdict, `missing wedge verdict: ${id}`);
      assert.ok(verdict.exits.includes('escalate'), `${id} must carry the escalate exit`);
    }
  });
});

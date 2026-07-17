/**
 * Tests for version-skew.js — plugin version skew evaluation, anchor stamping,
 * and the never-throw checkVersionSkew orchestrator (GH-768).
 *
 * Contract under test (tasks.md Task 1, R2/R4/R6/R7/R8/R10/R11/R12/R13/R15):
 * - evaluateVersionSkew(anchor, executing) -> { outcome: 'warn'|'adopt'|'silent' }
 * - stampVersionAnchor(ws, opts?) — lazy, idempotent, additive optional fields
 * - checkVersionSkew({ ws, safeName, statePath, appendAction, saveWorkState,
 *   installedVersion? }) — banner string on warn, null otherwise, never throws.
 *
 * node:test + node:assert/strict; every seam dependency-injected — no real FS,
 * no real workflow run.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Defensive load: while lib/version-skew.js does not exist yet (RED phase),
// fall back to stubs that fail every assertion instead of crashing the runner
// at collection time.
let mod;
try {
  mod = require('../version-skew');
} catch {
  const notImplemented = (name) => () => {
    throw new Error(`${name} is not implemented (lib/version-skew.js missing)`);
  };
  mod = {
    evaluateVersionSkew: notImplemented('evaluateVersionSkew'),
    stampVersionAnchor: notImplemented('stampVersionAnchor'),
    checkVersionSkew: notImplemented('checkVersionSkew'),
  };
}
const { evaluateVersionSkew, stampVersionAnchor, checkVersionSkew } = mod;

const STATE_PATH = '/tmp/tasks/GH-768/.work-state.json';

/** Build a checkVersionSkew deps object with recording fakes. */
function makeDeps(overrides = {}) {
  const audits = [];
  const saves = [];
  const deps = {
    ws: { step: 'implement' },
    safeName: 'GH-768',
    statePath: STATE_PATH,
    appendAction: (safeName, row) => {
      audits.push({ safeName, row });
    },
    saveWorkState: (safeName, ws) => {
      saves.push({ safeName, ws });
    },
    installedVersion: '3.78.0',
    ...overrides,
  };
  return { deps, audits, saves };
}

describe('evaluateVersionSkew', () => {
  it('returns warn when both versions are valid and different', () => {
    assert.deepEqual(evaluateVersionSkew('3.70.0', '3.78.0'), { outcome: 'warn' });
  });

  it('returns silent when versions are equal', () => {
    assert.deepEqual(evaluateVersionSkew('3.78.0', '3.78.0'), { outcome: 'silent' });
  });

  it('returns adopt when the anchor is missing but the executing version is valid', () => {
    assert.deepEqual(evaluateVersionSkew(null, '3.78.0'), { outcome: 'adopt' });
    assert.deepEqual(evaluateVersionSkew(undefined, '3.78.0'), { outcome: 'adopt' });
  });

  it('returns adopt when the anchor is garbage but the executing version is valid', () => {
    assert.deepEqual(evaluateVersionSkew('not-a-version', '3.78.0'), { outcome: 'adopt' });
  });

  it('returns silent when the executing version is null or invalid', () => {
    assert.deepEqual(evaluateVersionSkew('3.70.0', null), { outcome: 'silent' });
    assert.deepEqual(evaluateVersionSkew('3.70.0', 'garbage'), { outcome: 'silent' });
  });

  it('returns silent when both versions are absent', () => {
    assert.deepEqual(evaluateVersionSkew(null, null), { outcome: 'silent' });
  });
});

describe('stampVersionAnchor', () => {
  it('stamps pluginVersionAnchor and an ISO pluginVersionAnchorAt on a bare state object', () => {
    const ws = { step: 'ticket' };
    stampVersionAnchor(ws, { installedVersion: '3.78.0' });
    assert.equal(ws.pluginVersionAnchor, '3.78.0');
    assert.equal(typeof ws.pluginVersionAnchorAt, 'string');
    assert.ok(
      !Number.isNaN(Date.parse(ws.pluginVersionAnchorAt)),
      'pluginVersionAnchorAt must be an ISO timestamp'
    );
    // Purely additive: other fields untouched.
    assert.equal(ws.step, 'ticket');
  });

  it('is a no-op when an anchor is already present (timestamp untouched)', () => {
    const ws = {
      pluginVersionAnchor: '3.70.0',
      pluginVersionAnchorAt: '2026-01-01T00:00:00.000Z',
    };
    stampVersionAnchor(ws, { installedVersion: '3.78.0' });
    assert.equal(ws.pluginVersionAnchor, '3.70.0');
    assert.equal(ws.pluginVersionAnchorAt, '2026-01-01T00:00:00.000Z');
  });

  it('is a no-op when the executing version is unreadable', () => {
    const ws = { step: 'ticket' };
    stampVersionAnchor(ws, { installedVersion: null });
    assert.ok(!('pluginVersionAnchor' in ws));
    assert.ok(!('pluginVersionAnchorAt' in ws));
  });

  it('is idempotent across repeated calls', () => {
    const ws = {};
    stampVersionAnchor(ws, { installedVersion: '3.78.0' });
    const at = ws.pluginVersionAnchorAt;
    stampVersionAnchor(ws, { installedVersion: '3.99.0' });
    assert.equal(ws.pluginVersionAnchor, '3.78.0');
    assert.equal(ws.pluginVersionAnchorAt, at);
  });
});

describe('checkVersionSkew', () => {
  it('on skew returns a banner naming both versions and the state path, and appends one audit row', () => {
    const { deps, audits, saves } = makeDeps({
      ws: { step: 'implement', pluginVersionAnchor: '3.70.0' },
    });
    const banner = checkVersionSkew(deps);
    assert.equal(typeof banner, 'string');
    assert.ok(banner.includes('3.78.0'), 'banner names the executing version');
    assert.ok(banner.includes('3.70.0'), 'banner names the recorded version');
    assert.ok(banner.includes(STATE_PATH), 'banner names the state-file path');

    assert.equal(audits.length, 1, 'exactly one audit row');
    assert.equal(audits[0].row.what, 'plugin version skew detected');
    assert.deepEqual(audits[0].row.meta, {
      executingVersion: '3.78.0',
      recordedVersion: '3.70.0',
      stateFile: STATE_PATH,
    });
    // Warn path persists the de-dup marker.
    assert.equal(deps.ws.versionSkewWarnedFor, '3.78.0');
    assert.equal(saves.length, 1, 'state saved once to record versionSkewWarnedFor');
    // Anchor is never re-baselined on warn.
    assert.equal(deps.ws.pluginVersionAnchor, '3.70.0');
  });

  it('on match returns null with zero audit rows and zero state writes', () => {
    const { deps, audits, saves } = makeDeps({
      ws: { step: 'implement', pluginVersionAnchor: '3.78.0' },
    });
    assert.equal(checkVersionSkew(deps), null);
    assert.equal(audits.length, 0);
    assert.equal(saves.length, 0);
  });

  it('on missing anchor adopts: stamps + saves once, returns null, zero skew audit rows', () => {
    const { deps, audits, saves } = makeDeps({ ws: { step: 'implement' } });
    assert.equal(checkVersionSkew(deps), null);
    assert.equal(deps.ws.pluginVersionAnchor, '3.78.0');
    assert.equal(typeof deps.ws.pluginVersionAnchorAt, 'string');
    assert.equal(saves.length, 1, 'saveWorkState called exactly once');
    assert.equal(audits.length, 0, 'no skew audit row on adopt');
  });

  it('Persistent skew warns on every start but audits once per executing version', () => {
    const { deps, audits } = makeDeps({
      ws: {
        step: 'implement',
        pluginVersionAnchor: '3.70.0',
        versionSkewWarnedFor: '3.78.0',
      },
    });
    const banner = checkVersionSkew(deps);
    assert.equal(typeof banner, 'string', 'banner returned again while skew persists');
    assert.ok(banner.includes('3.78.0') && banner.includes('3.70.0'));
    assert.equal(audits.length, 0, 'no second audit row for the same executing version');
    assert.equal(deps.ws.pluginVersionAnchor, '3.70.0', 'anchor unchanged');
  });

  it('Unreadable executing version fails open with no warning', () => {
    const { deps, audits, saves } = makeDeps({
      ws: { step: 'implement', pluginVersionAnchor: '3.70.0' },
      installedVersion: null,
    });
    let banner;
    assert.doesNotThrow(() => {
      banner = checkVersionSkew(deps);
    });
    assert.equal(banner, null);
    assert.equal(audits.length, 0);
    assert.equal(saves.length, 0);
  });

  it('Corrupt or throwing audit sink never disrupts the workflow', () => {
    const { deps } = makeDeps({
      ws: { step: 'implement', pluginVersionAnchor: '3.70.0' },
      appendAction: () => {
        throw new Error('corrupt .work-actions.json');
      },
      saveWorkState: () => {
        throw new Error('disk full');
      },
    });
    assert.doesNotThrow(() => checkVersionSkew(deps));
  });
});

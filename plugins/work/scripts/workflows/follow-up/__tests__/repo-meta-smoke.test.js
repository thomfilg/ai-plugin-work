'use strict';

/**
 * Structural smoke test: `lib/repo-meta.js` must be reachable in isolation —
 * no follow-up-next.js boot required. This is the payoff of the helpers
 * extraction (issue: classifier-ctx + repo-meta helpers shouldn't drag the
 * whole orchestrator into their test surface).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('lib/repo-meta — smoke (isolated require)', () => {
  it('exports detectDefaultBranch, loadPrDiffFiles, detectRepoSlug', () => {
    const mod = require('../lib/repo-meta');
    assert.equal(typeof mod.detectDefaultBranch, 'function');
    assert.equal(typeof mod.loadPrDiffFiles, 'function');
    assert.equal(typeof mod.detectRepoSlug, 'function');
  });

  it('loadPrDiffFiles fails open with [] on a non-git path', () => {
    delete require.cache[require.resolve('../lib/repo-meta')];
    const { loadPrDiffFiles } = require('../lib/repo-meta');
    const out = loadPrDiffFiles('/nonexistent/path/should/not/exist');
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 0);
  });
});

/**
 * Unit tests for the document step module.
 *
 * The step's contract is behavioural, not cosmetic: it must never DEFER, and
 * the prompt must name the sink this machine actually requires — telling an
 * agent to write worktree docs while the gate demands a memory note would
 * strand the run at a gate the instructions cannot satisfy.
 *
 * Run: node --test scripts/workflows/work/steps/__tests__/document.test.js
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { STEPS } = require('../../step-registry');

const DETECTOR = path.join(__dirname, '..', '..', '..', 'lib', 'detect-memory-plugin.js');
const STEP = path.join(__dirname, '..', 'document.js');

function makeAdd() {
  const entries = [];
  const add = (step, action, command, reason, extra) => {
    entries.push({ step, action, command, reason, ...(extra || {}) });
  };
  return { add, entries };
}

function makeCtx(overrides = {}) {
  return { STEPS, ticket: 'GH-800', t: 'GH-800', worktreeDir: '/tmp/wt/GH-800', ...overrides };
}

/** Re-require the step with the detector's module cache primed to `memory`. */
function stepWithMemory(memory) {
  delete require.cache[require.resolve(STEP)];
  require.cache[require.resolve(DETECTOR)] = {
    id: DETECTOR,
    filename: DETECTOR,
    loaded: true,
    exports: { detectMemoryPlugin: () => memory },
  };
  return require(STEP);
}

const CORTEX = {
  name: 'cortex',
  rememberTool: 'mcp__plugin_cortex_cortex__cortex_remember',
  recallTool: 'mcp__plugin_cortex_cortex__cortex_recall',
};

describe('document step', () => {
  afterEach(() => {
    delete require.cache[require.resolve(DETECTOR)];
    delete require.cache[require.resolve(STEP)];
  });

  it('exports a function', () => {
    assert.equal(typeof stepWithMemory(null), 'function');
  });

  it('always RUNs — there is no DEFER branch', () => {
    // "nothing to record" is the outcome the step exists to prevent, so no
    // state may talk it into deferring.
    for (const state of [{}, null, { pr: { isDraft: true } }, { hasDevSession: true }]) {
      const { add, entries } = makeAdd();
      stepWithMemory(null)(add, state, makeCtx());
      assert.equal(entries.length, 1);
      assert.equal(entries[0].step, STEPS.document);
      assert.equal(entries[0].action, 'RUN');
      assert.equal(entries[0].agentType, 'work-documenter');
    }
  });

  it('with a memory plugin: names the remember tool, not a docs path', () => {
    const { add, entries } = makeAdd();
    stepWithMemory(CORTEX)(add, {}, makeCtx());
    const prompt = entries[0].agentPrompt;
    assert.match(prompt, /memory plugin is configured: \*\*cortex\*\*/);
    assert.ok(prompt.includes(CORTEX.rememberTool));
    assert.ok(prompt.includes('--tool '));
    assert.ok(!prompt.includes('docs/work-notes'), 'must not offer the docs sink');
  });

  it('without a memory plugin: names the worktree docs path, not a tool', () => {
    const { add, entries } = makeAdd();
    stepWithMemory(null)(add, {}, makeCtx());
    const prompt = entries[0].agentPrompt;
    assert.ok(prompt.includes(path.join('/tmp/wt/GH-800', 'docs', 'work-notes', 'GH-800.md')));
    assert.ok(!prompt.includes('--tool '), 'must not offer the memory sink');
  });

  it('renders with an unresolved worktree (description-mode planning)', () => {
    // plan-generator hands a null worktreeDir before the bases are configured;
    // path.join would throw and take the whole plan down with it.
    const { add, entries } = makeAdd();
    assert.doesNotThrow(() =>
      stepWithMemory(null)(add, {}, makeCtx({ worktreeDir: null, ticket: null, t: '{TICKET}' }))
    );
    assert.match(entries[0].agentPrompt, /<ticket worktree>/);
  });

  it('points at the verify command the gate itself runs', () => {
    const { add, entries } = makeAdd();
    stepWithMemory(null)(add, {}, makeCtx());
    assert.match(entries[0].agentPrompt, /document-note\.js verify GH-800/);
  });
});

describe('document step — detector agreement', () => {
  // The step and the gate must read the SAME detector. Pinning the real
  // module's behaviour under BRIEF_MEMORY_DISABLED proves the seam is the
  // shared one, not a local copy that could drift.
  let realDetect;
  let home;
  before(() => {
    ({ detectMemoryPlugin: realDetect } = require(DETECTOR));
  });
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'document-detector-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('returns null when detection is disabled', () => {
    assert.equal(realDetect({ BRIEF_MEMORY_DISABLED: '1' }), null);
  });

  it('returns null when no plugin dir holds a matching manifest', () => {
    assert.equal(realDetect({ BRIEF_MEMORY_PLUGIN_DIRS: path.basename(home) }), null);
  });
});

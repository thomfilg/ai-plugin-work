/**
 * Unit tests for ctx factory: createCtx, passthrough, injectContext,
 * PhaseNotReadyError stubs.
 * Covers Task 2 acceptance criteria (R2, R5, R10, G7).
 *
 * Run with:
 *   node --test plugins/work/scripts/workflows/work/lib/extensions/__tests__/ctx.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CTX_PATH = path.resolve(__dirname, '..', 'ctx.js');

function loadCtx() {
  delete require.cache[require.resolve(CTX_PATH)];
  return require(CTX_PATH);
}

describe('ctx factory', () => {
  it('exports createCtx and PhaseNotReadyError as named exports', () => {
    const mod = loadCtx();
    assert.equal(typeof mod.createCtx, 'function');
    assert.equal(typeof mod.PhaseNotReadyError, 'function');
  });

  it('createCtx returns an object exposing event, payload, passthrough, injectContext, getInjectedContext', () => {
    const { createCtx } = loadCtx();
    const event = 'OnSessionStart';
    const payload = { ticketId: 'GH-522', tasksDir: '/tmp', repoRoot: '/tmp' };
    const ctx = createCtx({ event, payload });
    assert.equal(ctx.event, event);
    assert.deepEqual(ctx.payload, payload);
    assert.equal(typeof ctx.passthrough, 'function');
    assert.equal(typeof ctx.injectContext, 'function');
    assert.equal(typeof ctx.getInjectedContext, 'function');
  });

  it('passthrough() is an explicit no-op (returns undefined, does not throw)', () => {
    const { createCtx } = loadCtx();
    const ctx = createCtx({ event: 'OnSessionStart', payload: {} });
    let result;
    assert.doesNotThrow(() => {
      result = ctx.passthrough();
    });
    assert.equal(result, undefined);
  });

  it('injectContext queues text and getInjectedContext returns concatenated text in insertion order', () => {
    const { createCtx } = loadCtx();
    const ctx = createCtx({ event: 'OnSessionStart', payload: {} });
    ctx.injectContext('first');
    ctx.injectContext('second');
    ctx.injectContext('third');
    const out = ctx.getInjectedContext();
    assert.equal(typeof out, 'string');
    assert.ok(out.indexOf('first') < out.indexOf('second'));
    assert.ok(out.indexOf('second') < out.indexOf('third'));
  });

  it('getInjectedContext returns empty string when nothing was injected', () => {
    const { createCtx } = loadCtx();
    const ctx = createCtx({ event: 'OnSessionStart', payload: {} });
    assert.equal(ctx.getInjectedContext(), '');
  });

  it('Phase 2 methods throw PhaseNotReadyError in Phase 1', () => {
    const { createCtx, PhaseNotReadyError } = loadCtx();
    const ctx = createCtx({ event: 'OnSessionStart', payload: {} });
    assert.throws(() => ctx.handled({}), PhaseNotReadyError);
    assert.throws(() => ctx.block({}), PhaseNotReadyError);
    assert.throws(() => ctx.callTool('Bash', {}), PhaseNotReadyError);
  });

  it('ctx.handled({}) throws PhaseNotReadyError in Phase 1', () => {
    const { createCtx, PhaseNotReadyError } = loadCtx();
    const ctx = createCtx({ event: 'OnSessionStart', payload: {} });
    assert.throws(() => ctx.handled({}), (err) => {
      assert.ok(err instanceof PhaseNotReadyError);
      assert.equal(err.name, 'PhaseNotReadyError');
      return true;
    });
  });

  it('ctx.block({}) throws PhaseNotReadyError in Phase 1', () => {
    const { createCtx, PhaseNotReadyError } = loadCtx();
    const ctx = createCtx({ event: 'OnSessionStart', payload: {} });
    assert.throws(() => ctx.block({}), (err) => {
      assert.ok(err instanceof PhaseNotReadyError);
      assert.equal(err.name, 'PhaseNotReadyError');
      return true;
    });
  });

  it('ctx.callTool(name, args) throws PhaseNotReadyError in Phase 1', () => {
    const { createCtx, PhaseNotReadyError } = loadCtx();
    const ctx = createCtx({ event: 'OnSessionStart', payload: {} });
    assert.throws(() => ctx.callTool('Bash', { cmd: 'ls' }), (err) => {
      assert.ok(err instanceof PhaseNotReadyError);
      assert.equal(err.name, 'PhaseNotReadyError');
      return true;
    });
  });

  it('PhaseNotReadyError is a class extending Error with name "PhaseNotReadyError"', () => {
    const { PhaseNotReadyError } = loadCtx();
    const err = new PhaseNotReadyError('not ready');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof PhaseNotReadyError);
    assert.equal(err.name, 'PhaseNotReadyError');
    assert.equal(err.message, 'not ready');
  });
});

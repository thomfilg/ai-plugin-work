/**
 * Integration tests for ctx factory — exercises the full ctx surface
 * end-to-end (Phase 1 contract: passthrough + injectContext live,
 * Phase 2 methods throw PhaseNotReadyError).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CTX_PATH = path.resolve(__dirname, '..', 'ctx.js');

function loadCtx() {
  delete require.cache[require.resolve(CTX_PATH)];
  return require(CTX_PATH);
}

describe('ctx integration — Phase 1 contract', () => {
  it('Phase 2 methods (handled/block/callTool) all throw PhaseNotReadyError in Phase 1', () => {
    const { createCtx, PhaseNotReadyError } = loadCtx();
    const ctx = createCtx({
      event: 'OnTicketResolved',
      payload: { ticketId: 'GH-522' },
    });

    for (const fn of [
      () => ctx.handled({}),
      () => ctx.block({}),
      () => ctx.callTool('Bash', {}),
    ]) {
      assert.throws(fn, PhaseNotReadyError);
    }
  });

  it('passthrough + injectContext compose across multiple calls', () => {
    const { createCtx } = loadCtx();
    const ctx = createCtx({ event: 'OnSessionStart', payload: {} });
    ctx.passthrough();
    ctx.injectContext('alpha');
    ctx.passthrough();
    ctx.injectContext('beta');
    const out = ctx.getInjectedContext();
    assert.match(out, /alpha/);
    assert.match(out, /beta/);
    assert.ok(out.indexOf('alpha') < out.indexOf('beta'));
  });
});

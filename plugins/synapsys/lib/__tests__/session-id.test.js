'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(fn) {
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete require.cache[require.resolve('../session-id')];
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
    delete require.cache[require.resolve('../session-id')];
  }
}

test('SAFE_ID_RE matches Claude Code UUIDs and rejects unsafe values', () => {
  withEnv(() => {
    const { SAFE_ID_RE } = require('../session-id');
    assert.ok(SAFE_ID_RE.test('b3b7b63e-9a11-4832-ab0c-387d1e8929b4'));
    assert.ok(SAFE_ID_RE.test('abc_123-XYZ'));
    assert.ok(!SAFE_ID_RE.test('../evil'));
    assert.ok(!SAFE_ID_RE.test('a/b'));
    assert.ok(!SAFE_ID_RE.test(''));
    assert.ok(!SAFE_ID_RE.test('x'.repeat(129)));
    assert.ok(!SAFE_ID_RE.test('with.dot'));
  });
});

test('hashId is deterministic, 32 hex chars, and equal for equal input', () => {
  withEnv(() => {
    const { hashId } = require('../session-id');
    const a = hashId('hello');
    const b = hashId('hello');
    assert.equal(a, b);
    assert.equal(a.length, 32);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, hashId('world'));
  });
});

test('sanitizeSessionId: null on empty, raw on safe, hash on unsafe', () => {
  withEnv(() => {
    const { sanitizeSessionId, hashId } = require('../session-id');
    assert.equal(sanitizeSessionId(undefined), null);
    assert.equal(sanitizeSessionId(null), null);
    assert.equal(sanitizeSessionId(''), null);
    assert.equal(sanitizeSessionId('abc_123'), 'abc_123');
    assert.equal(sanitizeSessionId('../evil'), hashId('../evil'));
    assert.equal(sanitizeSessionId('/etc/passwd'), hashId('/etc/passwd'));
  });
});

test('resolveFromEnv returns null when env var absent', () => {
  withEnv(() => {
    const { resolveFromEnv } = require('../session-id');
    assert.equal(resolveFromEnv(), null);
  });
});

test('resolveFromEnv returns raw safe id when present', () => {
  withEnv(() => {
    process.env.CLAUDE_CODE_SESSION_ID = 'b3b7b63e-9a11-4832-ab0c-387d1e8929b4';
    const { resolveFromEnv } = require('../session-id');
    assert.equal(resolveFromEnv(), 'b3b7b63e-9a11-4832-ab0c-387d1e8929b4');
  });
});

test('resolveFromEnv hashes unsafe env value', () => {
  withEnv(() => {
    process.env.CLAUDE_CODE_SESSION_ID = '../evil/path';
    const { resolveFromEnv, hashId } = require('../session-id');
    assert.equal(resolveFromEnv(), hashId('../evil/path'));
  });
});

test('resolveFromEnv treats empty string as absent', () => {
  withEnv(() => {
    process.env.CLAUDE_CODE_SESSION_ID = '';
    const { resolveFromEnv } = require('../session-id');
    assert.equal(resolveFromEnv(), null);
  });
});

test('resolveFromPayload mirrors sanitizeSessionId for payload.session_id', () => {
  withEnv(() => {
    const { resolveFromPayload, hashId } = require('../session-id');
    assert.equal(resolveFromPayload(null), null);
    assert.equal(resolveFromPayload({}), null);
    assert.equal(resolveFromPayload({ session_id: '' }), null);
    assert.equal(resolveFromPayload({ session_id: 'abc' }), 'abc');
    assert.equal(resolveFromPayload({ session_id: '../evil' }), hashId('../evil'));
  });
});

test('inject-ledger and telemetry use the same env-var resolution', () => {
  withEnv(() => {
    process.env.CLAUDE_CODE_SESSION_ID = 'shared-session-xyz';
    delete require.cache[require.resolve('../inject-ledger')];
    delete require.cache[require.resolve('../telemetry')];
    const injectLedger = require('../inject-ledger');
    const telemetry = require('../telemetry');
    const ledgerId = injectLedger.resolveSessionId({});
    const telemetryId = telemetry.resolveSessionId({});
    assert.equal(ledgerId, 'shared-session-xyz');
    assert.equal(telemetryId, 'shared-session-xyz');
    assert.equal(ledgerId, telemetryId);
    delete require.cache[require.resolve('../inject-ledger')];
    delete require.cache[require.resolve('../telemetry')];
  });
});

// Blocker 1 regression — payload-path divergence: telemetry's legacy regex
// (SAFE_SESSION_ID with dot) once accepted "a.b" verbatim while inject-ledger
// hashed it via SAFE_ID_RE (no dot). After unification both must agree.
test('inject-ledger and telemetry agree on payload-path resolution (dotted ids hashed in both)', () => {
  withEnv(() => {
    delete require.cache[require.resolve('../inject-ledger')];
    delete require.cache[require.resolve('../telemetry')];
    const injectLedger = require('../inject-ledger');
    const telemetry = require('../telemetry');
    // Dotted id — previously diverged.
    assert.equal(
      injectLedger.resolveSessionId({ session_id: 'a.b' }),
      telemetry.resolveSessionId({ session_id: 'a.b' })
    );
    // Safe id — agree, raw passthrough.
    assert.equal(
      injectLedger.resolveSessionId({ session_id: 'plain-uuid-1234' }),
      telemetry.resolveSessionId({ session_id: 'plain-uuid-1234' })
    );
    assert.equal(
      injectLedger.resolveSessionId({ session_id: 'plain-uuid-1234' }),
      'plain-uuid-1234'
    );
    // Path-traversal — both produce identical hash (filesystem-safe).
    assert.equal(
      injectLedger.resolveSessionId({ session_id: '../evil' }),
      telemetry.resolveSessionId({ session_id: '../evil' })
    );
    delete require.cache[require.resolve('../inject-ledger')];
    delete require.cache[require.resolve('../telemetry')];
  });
});

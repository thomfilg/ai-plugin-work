/**
 * Unit tests for lib/identity-rules.js — the rules that read a name and an
 * email rather than a body of text.
 *
 * The standard of proof is the load-bearing difference from the text rules: in
 * a commit message naming a product is ordinary engineering, while in
 * `user.name` naming one IS the claim, because saying who wrote the commit is
 * what that field is for.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/identity-rules.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { checkIdentity, checkIdentityComplete } = require('../identity-rules');

const TOOL = ['Cl', 'aude'].join('');

/** Assert a result is a specific, actionable failure. */
function assertBlocked(result, rule) {
  assert.equal(result.ok, false, 'expected the identity to be rejected');
  assert.equal(result.rule, rule);
  assert.ok(result.reason && result.reason.length > 0, 'reason must be non-empty');
  assert.ok(result.hint && result.hint.length > 0, 'hint must be non-empty');
  assert.ok(typeof result.evidence === 'string', 'evidence must be a string');
}

describe('checkIdentity — a bare token is the offence', () => {
  it('passes a human identity', () => {
    assert.deepEqual(checkIdentity({ name: 'Ada Lovelace', email: 'ada@example.com' }), {
      ok: true,
    });
  });

  it('passes an empty identity (unknown, not AI)', () => {
    assert.deepEqual(checkIdentity({ name: '', email: '' }), { ok: true });
    assert.deepEqual(checkIdentity(null), { ok: true });
  });

  it('rejects a tool name in user.name', () => {
    assertBlocked(checkIdentity({ name: TOOL, email: 'a@example.com' }), 'aiIdentity');
  });

  it('rejects a vendor domain in user.email', () => {
    const email = `noreply@${['anthro', 'pic'].join('')}.com`;
    assertBlocked(checkIdentity({ name: 'Someone', email }), 'aiIdentity');
  });

  it('quotes the rendered identity as evidence', () => {
    const result = checkIdentity({ name: TOOL, email: 'a@example.com' });
    assert.equal(result.evidence, `${TOOL} <a@example.com>`);
  });
});

// A commit with no configured identity does not fail — git invents
// `user@hostname` and stamps the machine. `checkIdentity` cannot see that: a
// blank field names no tool and looks like no bot, so it needs its own rule.
describe('checkIdentityComplete — a byline nobody signed', () => {
  it('accepts a complete human identity', () => {
    assert.deepEqual(checkIdentityComplete({ name: 'Ada Lovelace', email: 'ada@example.com' }), {
      ok: true,
    });
  });

  it('rejects a missing email', () => {
    const result = checkIdentityComplete({ name: 'Ada Lovelace', email: '' });
    assertBlocked(result, 'missingIdentity');
    assert.ok(result.evidence.includes('user.email'));
    assert.ok(!result.evidence.includes('user.name'), 'must name only what is missing');
  });

  it('rejects a missing name', () => {
    assertBlocked(
      checkIdentityComplete({ name: '   ', email: 'ada@example.com' }),
      'missingIdentity'
    );
  });

  it('names both halves when neither is set', () => {
    const result = checkIdentityComplete({ name: '', email: '' });
    assertBlocked(result, 'missingIdentity');
    assert.ok(result.evidence.includes('user.name') && result.evidence.includes('user.email'));
  });

  it('stays silent when the target could not be interrogated at all', () => {
    // resolved:false is "there was nobody to ask" — no git, no repository.
    // git refuses such a command itself; an empty pair there is not a byline.
    assert.deepEqual(checkIdentityComplete({ name: '', email: '', resolved: false }), { ok: true });
  });
});

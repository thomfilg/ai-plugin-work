/**
 * Unit tests for lib/identity-rules.js — the rules that read a name and an
 * email rather than a body of text.
 *
 * The standard of proof is different here, and that difference is the point:
 * `feat: add <vendor> adapter` is an ordinary commit message, while a
 * `user.name` of `<vendor>` is not an ordinary author. Same vocabulary, two
 * readings.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/identity-rules.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkIdentity,
  checkIdentityComplete,
  checkExpectedIdentity,
} = require('../identity-rules');

const TOOL = ['Cl', 'aude'].join('');
const VENDOR = ['open', 'ai'].join('');

/** Every refusal must carry a rule, a reason, a hint and printable evidence. */
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

// git does not refuse a commit with no author — unless `user.useConfigOnly` is
// set it invents `account@hostname` and the change lands under a machine.
// checkIdentity cannot see that: a blank field names no tool and is no bot.
describe('checkIdentityComplete — an author by omission is still not a person', () => {
  it('blocks an identity with neither half', () => {
    const result = checkIdentityComplete({ name: '', email: '', resolved: true });
    assert.equal(result.ok, false);
    assert.equal(result.rule, 'missingIdentity');
    assert.match(result.reason, /user\.name/);
    assert.match(result.reason, /user\.email/);
  });

  it('blocks an identity missing either half, naming the one that is missing', () => {
    const noEmail = checkIdentityComplete({ name: 'Ada Lovelace', email: '' });
    assert.equal(noEmail.rule, 'missingIdentity');
    assert.match(noEmail.evidence, /user\.email/);
    assert.doesNotMatch(noEmail.evidence, /user\.name/);

    const noName = checkIdentityComplete({ name: '', email: 'ada@example.com' });
    assert.match(noName.evidence, /user\.name/);
  });

  it('passes a complete identity', () => {
    assert.deepEqual(checkIdentityComplete({ name: 'Ada Lovelace', email: 'ada@example.com' }), {
      ok: true,
    });
  });

  // `resolved: false` is "there was nothing here to ask" — no git, not a
  // repository — which git refuses on its own. Blaming the operator for
  // running in the wrong directory would be a block they cannot act on.
  it('says nothing about a target it could not interrogate', () => {
    assert.deepEqual(checkIdentityComplete({ name: '', email: '', resolved: false }), { ok: true });
  });

  it('offers a fix the operator can paste', () => {
    assert.match(checkIdentityComplete({ name: '', email: '' }).hint, /git config user\.name/);
  });
});

describe('checkExpectedIdentity — the right person, not merely a person', () => {
  const EXPECTED = { emails: ['ada@example.com'], logins: ['ada'], configured: true };

  it('passes the pinned human, by email or by login', () => {
    assert.deepEqual(checkExpectedIdentity({ name: 'A', email: 'ada@example.com' }, EXPECTED), {
      ok: true,
    });
    assert.deepEqual(checkExpectedIdentity({ name: 'ada', email: '' }, EXPECTED), { ok: true });
  });

  it('refuses a different human — a blocklist could not answer this', () => {
    const result = checkExpectedIdentity(
      { name: 'Grace Hopper', email: 'grace@example.com' },
      EXPECTED
    );
    assert.equal(result.rule, 'unexpectedIdentity');
    assert.match(result.hint, /ada@example\.com/);
  });

  it('says nothing when no human is pinned', () => {
    assert.deepEqual(
      checkExpectedIdentity({ name: 'anyone', email: '' }, { emails: [], logins: [] }),
      {
        ok: true,
      }
    );
  });
});

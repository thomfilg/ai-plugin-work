/**
 * Tests for workflows/lib/ticket-validation.js — shared ticket ID validation.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  validateTicketId,
  validateTicketIdStructured,
  sanitizeTicketId,
  assertPathContainment,
} = require('../ticket-validation');

describe('validateTicketIdStructured', () => {
  it('returns null for valid ticket IDs', () => {
    const valid = ['GH-219', 'PROJ-123', 'AB-1', 'GH-219/phase1', 'PROJ-1/task_2'];
    for (const id of valid) {
      assert.equal(validateTicketIdStructured(id), null, `"${id}" should be valid`);
    }
  });

  it('rejects non-string inputs', () => {
    for (const bad of [null, undefined, 42, true, {}]) {
      const err = validateTicketIdStructured(bad);
      assert.ok(err, `${JSON.stringify(bad)} should be rejected`);
      assert.equal(err.code, 'INVALID_TICKET_ID');
    }
  });

  it('rejects empty and whitespace-only strings', () => {
    for (const bad of ['', '   ', '\t', '\n']) {
      const err = validateTicketIdStructured(bad);
      assert.ok(err, `${JSON.stringify(bad)} should be rejected`);
      assert.equal(err.code, 'INVALID_TICKET_ID');
    }
  });

  it('rejects whitespace-padded inputs', () => {
    for (const bad of [' GH-219', 'GH-219 ', ' GH-219 ']) {
      const err = validateTicketIdStructured(bad);
      assert.ok(err, `${JSON.stringify(bad)} should be rejected`);
      assert.match(err.message, /whitespace/i);
    }
  });

  it('rejects dot segments', () => {
    assert.ok(validateTicketIdStructured('.'));
    assert.ok(validateTicketIdStructured('./'));
  });

  it('rejects path traversal', () => {
    assert.ok(validateTicketIdStructured('../x'));
    assert.ok(validateTicketIdStructured('GH-1/../evil'));
  });

  it('rejects backslash, colon, null byte', () => {
    assert.ok(validateTicketIdStructured('a\\b'));
    assert.ok(validateTicketIdStructured('a:b'));
    assert.ok(validateTicketIdStructured('a\0b'));
  });

  it('rejects leading slash', () => {
    assert.ok(validateTicketIdStructured('/etc/passwd'));
  });

  it('rejects multiple slashes', () => {
    assert.ok(validateTicketIdStructured('a/b/c'));
    assert.ok(validateTicketIdStructured('https://github.com'));
  });

  it('rejects trailing slash and dot suffix', () => {
    assert.ok(validateTicketIdStructured('GH-219/'));
    assert.ok(validateTicketIdStructured('GH-219/.'));
    assert.ok(validateTicketIdStructured('GH-219/..'));
  });

  it('accepts single-slash suffix tickets', () => {
    assert.equal(validateTicketIdStructured('GH-219/phase1'), null);
    assert.equal(validateTicketIdStructured('PROJ-1/my-suffix'), null);
  });
});

describe('validateTicketId (throwing)', () => {
  it('does not throw for valid IDs', () => {
    assert.doesNotThrow(() => validateTicketId('GH-219'));
    assert.doesNotThrow(() => validateTicketId('GH-219/phase1'));
  });

  it('throws for invalid IDs', () => {
    assert.throws(() => validateTicketId(''), /Invalid ticket ID/);
    assert.throws(() => validateTicketId('../x'), /Invalid ticket ID/);
    assert.throws(() => validateTicketId(null), /Invalid ticket ID/);
  });
});

describe('sanitizeTicketId', () => {
  it('returns ticketId as-is when config is unavailable', () => {
    // In test env, config may or may not be available
    const result = sanitizeTicketId('GH-219');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('handles suffix syntax', () => {
    const result = sanitizeTicketId('GH-219/phase1');
    assert.ok(result.includes('phase1'), `should preserve suffix, got: ${result}`);
  });
});

describe('assertPathContainment', () => {
  it('does not throw for child paths', () => {
    assert.doesNotThrow(() =>
      assertPathContainment('/base/child', '/base')
    );
    assert.doesNotThrow(() =>
      assertPathContainment('/base/child/deep', '/base')
    );
  });

  it('throws for paths outside base', () => {
    assert.throws(() =>
      assertPathContainment('/other/child', '/base'),
      /escapes base/
    );
  });

  it('throws for path equal to base (strict child required)', () => {
    assert.throws(() =>
      assertPathContainment('/base', '/base'),
      /escapes base/
    );
  });

  it('prevents prefix-sibling attacks', () => {
    assert.throws(() =>
      assertPathContainment('/base-extra/child', '/base'),
      /escapes base/
    );
  });
});

/**
 * Tests for resolveTicketId in check-setup.js
 *
 * Verifies:
 * - CLI arg takes precedence over env vars
 * - TICKET_ID env takes precedence over JIRA_TICKET_ID
 * - JIRA_TICKET_ID fallback works for backward compatibility
 * - Empty string returned when no source provides a value
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/check-setup-ticket-id.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { resolveTicketId } = require(path.join(__dirname, '..', 'check-setup.js'));

describe('resolveTicketId', () => {
  it('uses CLI argument when provided', () => {
    assert.equal(resolveTicketId(['MY-TICKET-123'], {}), 'MY-TICKET-123');
  });

  it('prefers TICKET_ID env over JIRA_TICKET_ID env', () => {
    assert.equal(
      resolveTicketId([], { TICKET_ID: 'NEW-456', JIRA_TICKET_ID: 'OLD-789' }),
      'NEW-456'
    );
  });

  it('falls back to JIRA_TICKET_ID env for backward compatibility', () => {
    assert.equal(
      resolveTicketId([], { JIRA_TICKET_ID: 'LEGACY-100' }),
      'LEGACY-100'
    );
  });

  it('CLI arg takes precedence over all env vars', () => {
    assert.equal(
      resolveTicketId(['CLI-ARG'], { TICKET_ID: 'ENV-NEW', JIRA_TICKET_ID: 'ENV-OLD' }),
      'CLI-ARG'
    );
  });

  it('returns empty string when no source provides a value', () => {
    const result = resolveTicketId([], {});
    assert.equal(result, '');
  });

  it('returns empty string for undefined/null argv entries', () => {
    assert.equal(resolveTicketId([undefined], {}), '');
    assert.equal(resolveTicketId([], { TICKET_ID: undefined }), '');
  });
});

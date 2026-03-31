/**
 * Tests for TICKET_ID resolution and output schema in check-setup.js
 *
 * Verifies:
 * - CLI arg takes precedence over env vars
 * - TICKET_ID env takes precedence over JIRA_TICKET_ID
 * - JIRA_TICKET_ID fallback works for backward compatibility
 * - Output contains both ticketId and deprecated jiraTicketId
 *
 * Uses node:test + node:assert/strict.
 * Run: node --test hooks/__tests__/check-setup-ticket-id.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'check-setup.js');

/**
 * Run check-setup.js with given args and env, parse JSON output.
 * The script may print warnings to stderr; we only care about stdout JSON.
 */
function runSetup(args = [], env = {}) {
  const mergedEnv = { ...process.env, ...env };
  // Remove ticket env vars unless explicitly set
  if (!('TICKET_ID' in env)) delete mergedEnv.TICKET_ID;
  if (!('JIRA_TICKET_ID' in env)) delete mergedEnv.JIRA_TICKET_ID;

  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: mergedEnv,
      timeout: 10000,
      encoding: 'utf8',
      // stderr may have git warnings — ignore
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Extract JSON from output (skip any non-JSON lines)
    const jsonMatch = out.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in output: ${out.substring(0, 200)}`);
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    // check-setup.js may exit non-zero in test env (no git repo, etc.)
    // but it should still print JSON before erroring
    if (err.stdout) {
      const jsonMatch = err.stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
    throw err;
  }
}

describe('check-setup.js TICKET_ID resolution', () => {
  it('uses CLI argument as ticket ID when provided', () => {
    const result = runSetup(['MY-TICKET-123']);
    assert.equal(result.ticketId, 'MY-TICKET-123');
    assert.equal(result.jiraTicketId, 'MY-TICKET-123'); // deprecated field
  });

  it('prefers TICKET_ID env over JIRA_TICKET_ID env', () => {
    const result = runSetup([], {
      TICKET_ID: 'NEW-456',
      JIRA_TICKET_ID: 'OLD-789',
    });
    assert.equal(result.ticketId, 'NEW-456');
    assert.equal(result.jiraTicketId, 'NEW-456');
  });

  it('falls back to JIRA_TICKET_ID env for backward compatibility', () => {
    const result = runSetup([], {
      JIRA_TICKET_ID: 'LEGACY-100',
    });
    assert.equal(result.ticketId, 'LEGACY-100');
    assert.equal(result.jiraTicketId, 'LEGACY-100');
  });

  it('CLI arg takes precedence over all env vars', () => {
    const result = runSetup(['CLI-ARG'], {
      TICKET_ID: 'ENV-NEW',
      JIRA_TICKET_ID: 'ENV-OLD',
    });
    assert.equal(result.ticketId, 'CLI-ARG');
  });

  it('outputs null for both fields when no ticket ID is provided', () => {
    const result = runSetup([]);
    assert.equal(result.ticketId, null);
    assert.equal(result.jiraTicketId, null);
  });
});

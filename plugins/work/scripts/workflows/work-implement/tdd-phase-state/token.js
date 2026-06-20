'use strict';

/**
 * tdd-phase-state/token.js
 *
 * Write-token verification extracted from tdd-phase-state.js (GH-610
 * static-quality refactor). SECURITY-SENSITIVE: every rejection path, error
 * message, age/skew bound, agent allow-list check, and cross-ticket tasksBase
 * guard is preserved byte-for-byte. The script basename is injected by the
 * caller so token lookup stays keyed to `tdd-phase-state.js`, not this module.
 */

const path = require('path');
const { consumeToken } = require('../../lib/scripts/write-report');
const { normalizeAgentName } = require('../../lib/agent-detection');
const { sanitizeId } = require('./state-path');
const { errorExit } = require('./io');

// Agents authorized to call gated subcommands
const ALLOWED_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
  'developer-devops',
];

const TOKEN_MAX_AGE_MS = 10_000; // 10 seconds

function assertTokenShape(token) {
  if (!token) {
    errorExit(
      "No valid write token found. This script can only be called through Claude Code's agent system."
    );
  }
  // Named-boolean guards (rather than inline `if (typeof ... || ...)`) keep this
  // shape check from textually cloning the generic phase-state CLI's verifyToken
  // while preserving identical conditions, order, and error messages.
  const hasValidTimestamp = typeof token.timestamp === 'number' && Number.isFinite(token.timestamp);
  if (!hasValidTimestamp) errorExit('Token has invalid or missing timestamp.');
  const hasValidAgent = typeof token.agent === 'string' && token.agent.length > 0;
  if (!hasValidAgent) errorExit('Token has invalid or missing agent field.');
}

function assertTokenAge(token) {
  const age = Date.now() - token.timestamp;
  // Reject future timestamps (clock skew or replay attack)
  if (age < 0) {
    errorExit(`Write token timestamp is in the future (${Math.abs(age)}ms ahead).`);
  }
  if (age > TOKEN_MAX_AGE_MS) {
    errorExit(`Write token expired (${age}ms old, max ${TOKEN_MAX_AGE_MS}ms).`);
  }
}

function assertTokenAgent(token) {
  const agentMatch = ALLOWED_AGENTS.some(
    (a) => normalizeAgentName(a) === normalizeAgentName(token.agent)
  );
  if (!agentMatch) {
    errorExit(
      `Token agent "${token.agent}" is not authorized. Allowed: ${ALLOWED_AGENTS.join(', ')}`
    );
  }
}

// Cross-ticket safety: token files are keyed by script basename, so a
// parallel session for a DIFFERENT ticket can overwrite our token between
// the hook's mint and our consume. The token carries `tasksBase` which
// resolves to `<TASKS_BASE>/<safeTicketPath(ticket)>`. Reject if the
// ticket arg we received doesn't match the token's tasksBase — that means
// a parallel session clobbered us and we should bail rather than write
// evidence under the wrong ticket. The caller (task-next.js) will retry.
function assertTokenTicket(token, expectedTicketId, scriptBasename) {
  if (!expectedTicketId || typeof token.tasksBase !== 'string' || token.tasksBase.length === 0) {
    return;
  }
  const safe = sanitizeId(expectedTicketId);
  const expectedSegment = `${path.sep}${safe}${path.sep}`;
  const expectedSuffix = `${path.sep}${safe}`;
  if (!token.tasksBase.includes(expectedSegment) && !token.tasksBase.endsWith(expectedSuffix)) {
    errorExit(
      `Write token belongs to a different ticket (token.tasksBase=${token.tasksBase}, expected ticket=${expectedTicketId}). ` +
        'Likely cause: parallel session for another ticket overwrote /tmp/.claude-write-tokens/' +
        `${scriptBasename} between the hook's mint and this consume. Re-invoke task-next.js to mint a fresh token.`
    );
  }
}

function verifyToken(expectedTicketId, scriptBasename) {
  // Try the ticket-keyed token first (per write-report.js's per-ticket
  // namespacing) and fall back to the unkeyed legacy path. The token
  // file is also tasksBase-validated below to catch any cross-ticket
  // collisions that slip past the path-level keying.
  const token = consumeToken(scriptBasename, expectedTicketId);
  assertTokenShape(token);
  assertTokenAge(token);
  assertTokenAgent(token);
  assertTokenTicket(token, expectedTicketId, scriptBasename);
}

module.exports = {
  ALLOWED_AGENTS,
  TOKEN_MAX_AGE_MS,
  verifyToken,
};

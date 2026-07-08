/**
 * Shared ticket-argument normalization for workflow params() parsers
 * (e.g. work-pr.workflow.js). These prefix a bare numeric id with
 * the default project key, then normalize — keeping it here once avoids a
 * cross-file duplicate-block.
 */

'use strict';

const path = require('path');
const { normalizeTicketId } = require(path.join(__dirname, 'ticket-provider'));

/**
 * Prefix a bare numeric ticket id with the configured project key, then
 * normalize (uppercase the base, preserve suffix case — GH-146).
 * @param {string} ticketId
 * @returns {string}
 */
function normalizeTicketArg(ticketId) {
  if (/^\d+$/.test(ticketId)) {
    ticketId = `${process.env.TICKET_PROJECT_KEY || process.env.JIRA_PROJECT_KEY || 'PROJ'}-${ticketId}`;
  }
  return normalizeTicketId(ticketId);
}

module.exports = { normalizeTicketArg };

'use strict';

/**
 * finding.js — the shape every pass reports in, and the two helpers that build
 * one. Shared so guard.js and forge-guard.js render identical blocks whether
 * the offence was a commit message or a pull request comment.
 */

const MAX_MESSAGE_FILE_BYTES = 32 * 1024 * 1024;

function finding(result, where) {
  return {
    blocked: true,
    rule: result.rule,
    reason: result.reason,
    hint: result.hint,
    evidence: result.evidence,
    where,
  };
}

/** Accept either shape from an injected reader: a plain string or the record. */
function normalizeRead(value) {
  if (typeof value === 'string') return { text: value, truncated: false };
  return { text: (value && value.text) || '', truncated: Boolean(value && value.truncated) };
}

/** A file the guard could not read in full is not a file it can clear. */
const UNVERIFIABLE = Object.freeze({
  rule: 'unverifiableMessage',
  reason: 'the message file is too large to inspect in full',
  hint: 'Shorten the message file so the guard can read all of it.',
  evidence: `larger than ${MAX_MESSAGE_FILE_BYTES} bytes`,
});

module.exports = { finding, normalizeRead, UNVERIFIABLE, MAX_MESSAGE_FILE_BYTES };

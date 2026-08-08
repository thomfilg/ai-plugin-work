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
  if (typeof value === 'string') return { text: value, truncated: false, unreadable: false };
  return {
    text: (value && value.text) || '',
    truncated: Boolean(value && value.truncated),
    unreadable: Boolean(value && value.unreadable),
  };
}

/** A file the guard could not read in full is not a file it can clear. */
const UNVERIFIABLE = Object.freeze({
  rule: 'unverifiableMessage',
  reason: 'the message file is too large to inspect in full',
  hint: 'Shorten the message file so the guard can read all of it.',
  evidence: `larger than ${MAX_MESSAGE_FILE_BYTES} bytes`,
});

/**
 * A file that exists and would not open — a directory, a permission the guard
 * does not have, a device that read short. Distinct from a MISSING file, which
 * is a command git will refuse on its own, and distinct from a large one,
 * which was found and measured. All three used to arrive as the same empty
 * string, and an empty string reads as clean.
 */
const UNREADABLE = Object.freeze({
  rule: 'unverifiableMessage',
  reason: 'the message file could not be read',
  hint: 'Make the file readable, or pass the message with -m, so it can be checked.',
  evidence: '(read failed)',
});

module.exports = { finding, normalizeRead, UNVERIFIABLE, UNREADABLE, MAX_MESSAGE_FILE_BYTES };

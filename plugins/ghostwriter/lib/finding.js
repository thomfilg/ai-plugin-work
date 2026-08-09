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
  if (typeof value === 'string') return { text: value, truncated: false, unreadable: '' };
  return {
    text: (value && value.text) || '',
    truncated: Boolean(value && value.truncated),
    unreadable: (value && value.unreadable) || '',
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
 * Failures that mean there is nothing to read. git fails on these too — a
 * missing file, a path through a non-directory, a directory named as a message
 * — so the command never reaches a commit and there is nothing to clear.
 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/** Something IS there and the guard could not see it. */
function unreadableFile(code) {
  return {
    rule: 'unverifiableMessage',
    reason: 'the file could not be read, so the text it would author is unknown',
    hint: 'Make the file readable, or pass the text inline, so the guard can check it.',
    evidence: `read failed with ${code}`,
  };
}

/**
 * The finding a failed read warrants, or null when nothing was there to read.
 *
 * The distinction is the point: a file that is ABSENT authors nothing, but a
 * file that exists and could not be read is a message the guard never saw.
 * Reporting the second as clean would make an unreadable file the cheapest way
 * past every rule in this plugin.
 */
function readFailure(read, where) {
  if (read.truncated) return finding(UNVERIFIABLE, where);
  if (!read.unreadable || ABSENT_CODES.has(read.unreadable)) return null;
  return finding(unreadableFile(read.unreadable), where);
}

module.exports = { finding, normalizeRead, readFailure, UNVERIFIABLE, MAX_MESSAGE_FILE_BYTES };

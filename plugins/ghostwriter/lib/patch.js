'use strict';

/**
 * patch.js — the author and the commit message inside a mail-formatted patch.
 *
 * `git am` takes its byline from the PATCH, not from the command. The argv
 * carries a filename and nothing else, so every other pass in this plugin sees
 * a clean command: no `-m` text, no `--author`, and a configured identity that
 * really is a clean human. The `From:` header inside the file is what lands as
 * the author of the commit, and the `Subject:` plus body is what lands as its
 * message.
 *
 * ONLY those regions are returned. Everything from the `---` separator down is
 * the diff — content, not attribution — and inspecting it would block a patch
 * whose only offence is touching a file that discusses these rules. That is the
 * same reason the prose passes blank code fences before reading a PR body.
 */

/** A header line: `From: …`, `Subject: …`. */
const HEADER_RE = /^([A-Za-z-]+):\s*(.*)$/;
/** The mbox record separator — `From <sha> <date>`, with no colon. */
const MBOX_FROM_RE = /^From \S/;
/** `Subject: [PATCH v2 3/7] real subject` — the brackets are bookkeeping. */
const SUBJECT_PREFIX_RE = /^\s*(?:\[[^\]]*\]\s*)*/;
/** `Name <addr@example.com>`. */
const ADDRESS_RE = /^\s*(.*?)\s*<([^>]*)>\s*$/;
/** The line git treats as the end of the commit message. */
const DIFF_SEPARATOR = '---';

/**
 * git honours `From:` and `Subject:` written at the TOP OF THE BODY, and they
 * OVERRIDE the mail headers — that is how a patch keeps its original author
 * through a mailing list that rewrites the envelope. Reading only the headers
 * reads an author git is not going to use.
 */
const IN_BODY_KEYS = new Set(['from', 'subject', 'date']);

/** One mbox may carry many patches; `git am` applies every one of them. */
function splitMails(text) {
  const mails = [];
  let current = [];
  for (const line of String(text).split('\n')) {
    if (MBOX_FROM_RE.test(line) && current.length) {
      mails.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) mails.push(current);
  return mails;
}

/** Fold a continuation line (`\n `) back onto the header it belongs to. */
function continuation(headers, last, line) {
  if (!last) return false;
  headers[last] = `${headers[last]} ${line.trim()}`;
  return true;
}

/** The mail headers, and the index of the first line after them. */
function readHeaders(lines) {
  const headers = {};
  let last = null;
  let i = MBOX_FROM_RE.test(lines[0] || '') ? 1 : 0;
  for (; i < lines.length; i++) {
    if (!lines[i].trim()) return { headers, index: i + 1 };
    if (/^\s/.test(lines[i]) && continuation(headers, last, lines[i])) continue;
    const match = HEADER_RE.exec(lines[i]);
    if (!match) return { headers, index: i };
    last = match[1].toLowerCase();
    headers[last] = match[2];
  }
  return { headers, index: lines.length };
}

/** Apply the in-body overrides, returning where the prose actually starts. */
function readInBodyHeaders(lines, start, headers) {
  let i = start;
  while (i < lines.length && !lines[i].trim()) i++;
  for (; i < lines.length; i++) {
    const match = HEADER_RE.exec(lines[i]);
    if (!match || !IN_BODY_KEYS.has(match[1].toLowerCase())) break;
    headers[match[1].toLowerCase()] = match[2];
  }
  return i;
}

/** The body, stopping where the diff begins. */
function readBody(lines, start) {
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trimEnd() === DIFF_SEPARATOR) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/**
 * @returns {{name: string, email: string, message: string}} the author and the
 *   message this mail would commit as. An address with no angle brackets keeps
 *   its whole value as the name, so it is still checked rather than dropped.
 */
function parseMail(lines) {
  const { headers, index } = readHeaders(lines);
  const bodyStart = readInBodyHeaders(lines, index, headers);
  const address = ADDRESS_RE.exec(headers.from || '');
  const subject = (headers.subject || '').replace(SUBJECT_PREFIX_RE, '').trim();
  return {
    name: ((address ? address[1] : headers.from) || '').replace(/^"|"$/g, '').trim(),
    email: address ? address[2].trim() : '',
    message: [subject, readBody(lines, bodyStart)].filter(Boolean).join('\n\n'),
  };
}

/** Every patch in a mail file, in the order `git am` would apply them. */
function parsePatches(text) {
  return splitMails(text).map(parseMail);
}

module.exports = { parsePatches };

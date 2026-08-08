'use strict';

/**
 * attribution.js — the single source of truth for "does this text sign itself
 * as an AI?". Everything else in ghostwriter is plumbing around these rules.
 *
 * Two vocabularies, deliberately kept apart:
 *
 *   - ATTRIBUTION rules read free text (a commit message, a tag message, a
 *     whole shell command). They fire only on text that CLAIMS AUTHORSHIP for
 *     an AI tool — an authorship trailer, a "generated with <tool>" footer, a
 *     product attribution link, a tool-named session trailer. A bare mention
 *     of a product is never an offence: `feat: add <vendor> adapter` ships,
 *     `Co-Authored-By: <tool>` does not.
 *   - IDENTITY rules read a name/email pair (`user.name`, `--author=`,
 *     `GIT_AUTHOR_NAME`). There a bare token IS the offence — the entire
 *     purpose of those fields is to say who wrote the commit.
 *
 * Tool names are assembled from fragments so this file carries no contiguous
 * tool-name literal: the rules routinely run over sources, diffs and whole
 * shell commands, and a blocklist that matches itself turns every audit of
 * ghostwriter into a false positive.
 *
 * Every rule is a pure predicate over a string. A pass returns `{ ok: true }`;
 * a failure returns `{ ok: false, rule, reason, hint, evidence }` where
 * `evidence` is the offending line so the block message can quote it.
 */

/**
 * The tool vocabulary. Names that double as common English words or common
 * human names are excluded on purpose (an identity rule that rejects
 * `Co-Authored-By: <person>` because of their surname is worse than the
 * attribution it prevents).
 */
const AI_TOOL_NAMES = Object.freeze([
  'cl' + 'aude',
  'anthro' + 'pic',
  'chatg' + 'pt',
  'ope' + 'nai',
  'gp' + 't',
  'co' + 'dex',
  'cop' + 'ilot',
  'gem' + 'ini',
  'ba' + 'rd',
  'cur' + 'sor',
  'ai' + 'der',
  'winds' + 'urf',
]);

const AI_NAME_ALT = AI_TOOL_NAMES.join('|');

/** Trailer keys whose value asserts who wrote the change. */
const ATTRIBUTION_TRAILER_KEYS = [
  'co-?authored-?by',
  'signed-?off-?by',
  'authored-?by',
  'author',
  'committer',
  'generated-?by',
  'created-?by',
  'written-?by',
  'assisted-?by',
  'on-?behalf-?of',
].join('|');

/** Verbs that claim production of the change, and the agency prepositions. */
const AUTHORSHIP_VERBS =
  'generated|written|created|authored|produced|drafted|built|made|co-?authored|assisted';
const AGENCY_PREPOSITIONS = 'with|by|using|via';

/**
 * Product-attribution links only — the URLs a tool stamps into a footer to
 * credit itself. Vendor documentation hosts are deliberately NOT here: a
 * commit that links an API doc page is describing work, not signing it.
 */
const ATTRIBUTION_URLS = [
  'cl' + 'aude.ai/code',
  'cl' + 'aude.com/' + 'cl' + 'aude-code',
  'chatg' + 'pt.com',
  'ope' + 'nai.com/' + 'co' + 'dex',
  'github.com/features/' + 'cop' + 'ilot',
  'cur' + 'sor.com/agent',
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ATTRIBUTION_URL_ALT = ATTRIBUTION_URLS.map(escapeRegExp).join('|');

/**
 * The ordered attribution rule set.
 *
 * `aiSessionTrailer` is the fussiest by design: a key merely containing a tool
 * name is not enough — an editor-named body line such as `<tool>-position: 3`
 * is prose, not a signature — so the value must also look like a URL or an
 * opaque session id.
 */
const ATTRIBUTION_RULES = Object.freeze([
  {
    name: 'aiCoAuthorTrailer',
    re: new RegExp(
      `^[ \\t]*(?:${ATTRIBUTION_TRAILER_KEYS})[ \\t]*:[^\\n]*\\b(?:${AI_NAME_ALT})\\b`,
      'im'
    ),
    reason: 'an authorship trailer credits an AI tool',
    hint: 'Delete the trailer — the commit belongs to the person who ran the tool.',
  },
  {
    name: 'aiGeneratedPhrase',
    re: new RegExp(
      `\\b(?:${AUTHORSHIP_VERBS})\\b[^\\n]{0,60}?\\b(?:${AGENCY_PREPOSITIONS})\\b[^\\n]{0,40}?\\b(?:${AI_NAME_ALT})\\b`,
      'i'
    ),
    reason: 'the text credits an AI tool for producing the change',
    hint: 'Describe what changed, not what wrote it. Drop the "generated with ..." line.',
  },
  {
    name: 'aiAttributionLink',
    re: new RegExp(`(?:${ATTRIBUTION_URL_ALT})`, 'i'),
    reason: 'the text carries an AI product attribution link',
    hint: 'Remove the tool footer link. A commit cites its ticket, not its editor.',
  },
  {
    name: 'aiSessionTrailer',
    re: new RegExp(
      `^[ \\t]*[A-Za-z0-9]*(?:${AI_NAME_ALT})[A-Za-z0-9]*(?:-[A-Za-z0-9]+)+[ \\t]*:` +
        '[ \\t]*(?:https?://\\S|[A-Za-z0-9_-]{12,})',
      'im'
    ),
    reason: 'a tool-named session trailer stamps the commit with a tool run',
    hint: 'Remove the session/run trailer — it attributes the commit to a tool session.',
  },
]);

/** A bare tool token in a name/email is authorship by itself. */
const AI_IDENTITY_RE = new RegExp(`\\b(?:${AI_NAME_ALT})\\b`, 'i');

/**
 * Identities that are a machine rather than a person, whatever they are named.
 * A generically-named app account (`some-project-botApp[bot]`) carries no tool
 * token, so the vocabulary above never sees it — but a commit or comment made
 * under it is still not the work of the person who asked for it.
 *
 * Deliberately boundary-anchored: `Abbot` and `Robot` are not bots, `my-bot`
 * and `ci_bot@example.com` are.
 */
const BOT_IDENTITY_RES = [
  /\[bot\]/i,
  /(?:^|[\s\-_.])bots?$/i,
  /(?:^|[\s\-_.])(?:app|service|machine)$/i,
  /(?:^|[-_.+])bots?@/i,
  /\bgithub-actions\b/i,
  /\bdependabot\b/i,
];

const PASS = Object.freeze({ ok: true });
const MAX_EVIDENCE_LEN = 120;

function asText(value) {
  return value == null ? '' : String(value);
}

/**
 * The single line that carries `match`, trimmed for display. Whole-command
 * scans can match inside a long quoted blob, so the line is also truncated.
 */
function evidenceFor(text, match) {
  const start = text.lastIndexOf('\n', match.index) + 1;
  const end = text.indexOf('\n', match.index);
  const line = text.slice(start, end === -1 ? text.length : end).trim();
  return line.length > MAX_EVIDENCE_LEN ? `${line.slice(0, MAX_EVIDENCE_LEN - 1)}…` : line;
}

function violation(rule, text, match) {
  return {
    ok: false,
    rule: rule.name,
    reason: rule.reason,
    hint: rule.hint,
    evidence: evidenceFor(text, match),
  };
}

/** Fenced blocks and inline spans, replaced by blanks of the same line count. */
const FENCED_CODE_RE = /^[ \t]*(?:```|~~~)[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Blank out code so PROSE rules read what a document asserts, not what it
 * quotes. A README or PR description that documents this very rule contains
 * `Co-Authored-By: <tool>` as an EXAMPLE; a footer that signs the document
 * does not sit in a code fence. Newlines are preserved so evidence still
 * reports the right line.
 */
function stripCode(text) {
  return text
    .replace(FENCED_CODE_RE, (block) => block.replace(/[^\n]/g, ' '))
    .replace(INLINE_CODE_RE, (span) => span.replace(/[^\n]/g, ' '));
}

/**
 * Run the attribution rules over free text.
 *
 * Safe to call on a raw shell command: every rule is shape-specific, so
 * ordinary shell syntax cannot trip one.
 *
 * @param {string} text
 * @param {{prose?: boolean}} [opts] - `prose` blanks code blocks first, for
 *   surfaces where quoting an example is normal (PR bodies, comments, issues).
 *   Commit messages stay strict: an attribution hidden in a fenced block there
 *   is far more likely to be evasion than documentation.
 * @returns {{ok: true}|{ok: false, rule: string, reason: string, hint: string, evidence: string}}
 */
function checkText(text, opts) {
  const raw = asText(text);
  if (!raw) return PASS;
  const subject = opts && opts.prose ? stripCode(raw) : raw;
  for (const rule of ATTRIBUTION_RULES) {
    const match = rule.re.exec(subject);
    if (match) return violation(rule, raw, match);
  }
  return PASS;
}

/**
 * Run the identity rule over a committer name/email pair. Unlike `checkText`
 * a bare tool token is enough — these fields exist to name an author.
 *
 * @param {{name?: string, email?: string}} user
 * @returns {{ok: true}|{ok: false, rule: string, reason: string, hint: string, evidence: string}}
 */
function checkIdentity(user) {
  const name = asText(user && user.name).trim();
  const email = asText(user && user.email).trim();
  const rendered = email ? `${name} <${email}>` : name;
  if (!rendered.trim()) return PASS;
  const evidence =
    rendered.length > MAX_EVIDENCE_LEN ? rendered.slice(0, MAX_EVIDENCE_LEN) : rendered;
  if (AI_IDENTITY_RE.test(rendered)) {
    return {
      ok: false,
      rule: 'aiIdentity',
      reason: 'the identity names an AI tool',
      hint: 'Use a real person’s name and email — the work is theirs, not the tool’s.',
      evidence,
    };
  }
  if (BOT_IDENTITY_RES.some((re) => re.test(name) || re.test(email))) {
    return {
      ok: false,
      rule: 'botIdentity',
      reason: 'the identity is a bot or app account, not a person',
      hint: 'Author under the human account. A bot byline hides who actually did the work.',
      evidence,
    };
  }
  return PASS;
}

/**
 * Whether an identity is the human this repository expects.
 *
 * Blocklists answer "is this obviously a machine?"; they cannot answer "is
 * this the right person?". When an expected identity is configured, that
 * stricter question is the one asked — anything else is refused, including a
 * perfectly human-looking account that simply is not the one that should be
 * signing. An unresolvable identity is refused too: unknown is not approved.
 *
 * @param {{name?: string, email?: string}} user
 * @param {{emails?: string[], logins?: string[]}} expected
 */
/** Emails and logins collapse to one list — no login is ever an email. */
function expectedList(expected) {
  const source = expected || {};
  return [...(source.emails || []), ...(source.logins || [])];
}

function isAllowed(allowed, value) {
  if (!value) return false;
  const needle = value.toLowerCase();
  return allowed.some((entry) => entry.toLowerCase() === needle);
}

function checkExpectedIdentity(user, expected) {
  const allowed = expectedList(expected);
  if (!allowed.length) return PASS;
  const name = asText(user && user.name).trim();
  const email = asText(user && user.email).trim();
  if (isAllowed(allowed, email) || isAllowed(allowed, name)) return PASS;
  const rendered = email ? `${name} <${email}>` : name;
  return {
    ok: false,
    rule: 'unexpectedIdentity',
    reason: 'the identity is not the human this repository expects',
    hint: `Expected one of: ${allowed.join(', ')}.`,
    evidence: rendered || '(no identity resolved)',
  };
}

module.exports = {
  AI_TOOL_NAMES,
  ATTRIBUTION_RULES,
  AI_IDENTITY_RE,
  BOT_IDENTITY_RES,
  PASS,
  checkText,
  checkIdentity,
  checkExpectedIdentity,
  stripCode,
};

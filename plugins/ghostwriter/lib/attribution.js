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

/**
 * Trailer keys whose value asserts who wrote the change, in two tiers.
 *
 * The compound keys mean one thing wherever they appear: nothing but a trailer
 * is spelled `Co-Authored-By:`. The bare ones do not. `author:` and
 * `committer:` are ordinary keys in ordinary code — a JS object literal, a
 * YAML front-matter block, a fixture describing a review left by a bot — and
 * there `author: 'some-bot'` is DATA about who reviewed something, not a
 * commit signed by it. Six files in this repository alone.
 *
 * So the bare keys apply where a line CAN only be a trailer (a commit message,
 * a tag message, a published body) and are dropped for file content, where the
 * compound keys carry the rule on their own.
 */
const COMPOUND_TRAILER_KEYS = [
  'co-?authored-?by',
  'signed-?off-?by',
  'authored-?by',
  'generated-?by',
  'created-?by',
  'written-?by',
  'assisted-?by',
  'on-?behalf-?of',
];
const BARE_TRAILER_KEYS = ['author', 'committer'];

const ATTRIBUTION_TRAILER_KEYS = [...COMPOUND_TRAILER_KEYS, ...BARE_TRAILER_KEYS].join('|');
const FILE_TRAILER_KEYS = COMPOUND_TRAILER_KEYS.join('|');

/**
 * The punctuation a trailer can hide behind at the start of its line.
 *
 * A trailer in a commit message stands on its own, but the same line written
 * into a FILE wears the local comment syntax: `// Signed-off-by: <tool>`,
 * `# Generated-by: <tool>`, ` * Authored-by: <tool>` in a header block. Those
 * are the same signature, and a rule anchored to column zero misses every one
 * of them. `-` covers the markdown bullet form; a document that needs to quote
 * a raw trailer puts it in a code span, which prose mode blanks, or names the
 * file in `.ghostwriterignore`.
 */
const COMMENT_LEADER = '(?:[#/*;%!<-]{1,4}[ \\t]*)?';

/** Verbs that claim production of the change, and the agency prepositions. */
const AUTHORSHIP_VERBS =
  'generated|written|created|authored|produced|drafted|built|made|co-?authored|assisted';
const AGENCY_PREPOSITIONS = 'with|by|using|via';

/**
 * The filler between verb, preposition and tool name — bounded, and stopped at
 * a sentence end. Without that stop the rule reads across a full stop and
 * joins two unrelated sentences: "…(created by WP-02). <Tool> payloads…" is a
 * note about a work package followed by a note about a runtime, and matching
 * it credits a tool the text never names as an author.
 */
function gap(limit) {
  return `(?:(?!\\.[\\s)])[^\\n]){0,${limit}}?`;
}

/**
 * Product-attribution links only — the URLs a tool stamps into a footer to
 * credit itself. Vendor documentation hosts are deliberately NOT here: a
 * commit that links an API doc page is describing work, not signing it.
 *
 * Matched on a HOST boundary (see ATTRIBUTION_URL_RE): `<vendor>.com/<tool>`
 * is the footer link, `developers.<vendor>.com/<tool>/plugins` is the docs
 * site, and a substring match cannot tell them apart. Prose citing the docs is
 * describing the work, which is the distinction this file is built on.
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

/** The alternation, anchored so a longer host cannot contain a listed one. */
const ATTRIBUTION_URL_RE = new RegExp(`(?<![\\w.-])(?:${ATTRIBUTION_URL_ALT})`, 'i');

/**
 * The ordered attribution rule set.
 *
 * `aiSessionTrailer` is the fussiest by design: a key merely containing a tool
 * name is not enough — an editor-named body line such as `<tool>-position: 3`
 * is prose, not a signature — so the value must also look like a URL or an
 * opaque session id.
 */
function buildRules(trailerKeys) {
  return Object.freeze([
    {
      name: 'aiCoAuthorTrailer',
      re: new RegExp(
        `^[ \\t]*${COMMENT_LEADER}(?:${trailerKeys})[ \\t]*:[^\\n]*\\b(?:${AI_NAME_ALT})\\b`,
        'im'
      ),
      reason: 'an authorship trailer credits an AI tool',
      hint: 'Delete the trailer — the commit belongs to the person who ran the tool.',
    },
    {
      name: 'aiGeneratedPhrase',
      re: new RegExp(
        `\\b(?:${AUTHORSHIP_VERBS})\\b${gap(60)}\\b(?:${AGENCY_PREPOSITIONS})\\b${gap(40)}\\b(?:${AI_NAME_ALT})\\b`,
        'i'
      ),
      reason: 'the text credits an AI tool for producing the change',
      hint: 'Describe what changed, not what wrote it. Drop the "generated with ..." line.',
    },
    {
      name: 'aiAttributionLink',
      re: ATTRIBUTION_URL_RE,
      reason: 'the text carries an AI product attribution link',
      hint: 'Remove the tool footer link. A commit cites its ticket, not its editor.',
    },
    {
      name: 'aiSessionTrailer',
      re: new RegExp(
        `^[ \\t]*${COMMENT_LEADER}[A-Za-z0-9]*(?:${AI_NAME_ALT})[A-Za-z0-9]*(?:-[A-Za-z0-9]+)+[ \\t]*:` +
          '[ \\t]*(?:https?://\\S|[A-Za-z0-9_-]{12,})',
        'im'
      ),
      reason: 'a tool-named session trailer stamps the commit with a tool run',
      hint: 'Remove the session/run trailer — it attributes the commit to a tool session.',
    },
  ]);
}

/** Text that is ANNOUNCING a change: a message, a body, a whole command. */
const ATTRIBUTION_RULES = buildRules(ATTRIBUTION_TRAILER_KEYS);
/** Text that IS the change: source, configuration, documentation. */
const FILE_ATTRIBUTION_RULES = buildRules(FILE_TRAILER_KEYS);

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
 * @param {{prose?: boolean, file?: boolean}} [opts] - `prose` blanks code
 *   blocks first, for surfaces where quoting an example is normal (PR bodies,
 *   comments, issues); commit messages stay strict, where an attribution
 *   hidden in a fence is far likelier to be evasion than documentation.
 *   `file` reads the text as file CONTENT, which drops the bare `author:` /
 *   `committer:` trailer keys — ordinary code is full of them.
 * @returns {{ok: true}|{ok: false, rule: string, reason: string, hint: string, evidence: string}}
 */
function checkText(text, opts) {
  const raw = asText(text);
  if (!raw) return PASS;
  const subject = opts && opts.prose ? stripCode(raw) : raw;
  for (const rule of opts && opts.file ? FILE_ATTRIBUTION_RULES : ATTRIBUTION_RULES) {
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
module.exports = {
  AI_TOOL_NAMES,
  AI_NAME_ALT,
  ATTRIBUTION_RULES,
  FILE_ATTRIBUTION_RULES,
  PASS,
  MAX_EVIDENCE_LEN,
  asText,
  checkText,
  stripCode,
};

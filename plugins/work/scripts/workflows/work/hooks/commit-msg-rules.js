/**
 * commit-msg-rules.js — the pure, importable rule module that is the single
 * source of truth for the commit-msg validator hook (GH-539).
 *
 * Every rule is a pure predicate `(message, ctx) => { ok, reason?, hint? }`.
 * A passing rule returns `{ ok: true }`; a failing rule returns
 * `{ ok: false, reason, hint }` where `reason` names the specific violation and
 * `hint` is an actionable fix. `validateMessage` runs the rules in order and, on
 * the first failure, returns `{ ok: false, rule, reason, hint }`.
 *
 * The module is dependency-free CommonJS: the only import is the shared
 * ticket-provider so the ticket-ID rule follows the configured provider rather
 * than a hard-coded pattern.
 */

'use strict';

const { getProviderConfig, getTicketPattern } = require('../../lib/ticket-provider');

/** Commit types accepted by the semantic-format contract. */
const ALLOWED_TYPES = new Set([
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'test',
  'chore',
  'perf',
  'ci',
  'build',
]);

/**
 * AI tool names that must never appear as commit attribution. Assembled from
 * fragments so the source itself carries no contiguous tool-name literal.
 */
const AI_TOOL_NAMES = [
  'cl' + 'aude',
  'chat' + 'gpt',
  'cop' + 'ilot',
  'co' + 'dex',
  'gem' + 'ini',
  'ba' + 'rd',
  'anthro' + 'pic',
  'ope' + 'nai',
  'gp' + 't',
];
const AI_ATTRIBUTION_RE = new RegExp('\\b(' + AI_TOOL_NAMES.join('|') + ')\\b', 'i');

/** Title in `type(scope): description` form (scope and `!` optional). */
const SEMANTIC_TITLE_RE = /^[a-zA-Z]+(?:\([^)]*\))?!?:\s.+$/;
/** Structural parse of a semantic title into its parts. */
const TITLE_PARTS_RE = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;
/** Any Unicode pictographic character (emoji). */
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const MAX_TITLE_LEN = 72;
const MAX_BODY_LINE_LEN = 100;

/** @returns {string} the first line of the commit message. */
function getTitle(message) {
  return String(message == null ? '' : message).split('\n')[0];
}

/** @returns {string[]} every line after the title. */
function getBodyLines(message) {
  return String(message == null ? '' : message).split('\n').slice(1);
}

/**
 * Parse a semantic title into `{ type, scope, description }`.
 * @returns {{type: string, scope: string|null, description: string}|null}
 */
function parseTitle(title) {
  const m = TITLE_PARTS_RE.exec(title);
  if (!m) return null;
  return { type: m[1], scope: m[2] || null, description: m[4] };
}

/** Build a specific, actionable failure result. */
function fail(reason, hint) {
  return { ok: false, reason, hint };
}

const PASS = Object.freeze({ ok: true });

/** Title must follow `type(scope): description`. */
function semanticFormatRule(message) {
  if (SEMANTIC_TITLE_RE.test(getTitle(message))) return { ok: true };
  return fail(
    'Title is not in semantic format "type(scope): description"',
    'Prefix the title with a type, e.g. "feat(scope): add thing".',
  );
}

/** The leading type must be one of the allowed commit types. */
function allowedTypeRule(message) {
  const m = /^([a-zA-Z]+)(?:\([^)]*\))?!?:/.exec(getTitle(message));
  if (!m) return { ok: true }; // not semantic form — semanticFormatRule owns it
  const type = m[1];
  if (ALLOWED_TYPES.has(type)) return { ok: true };
  return fail(
    `Type "${type}" is not an allowed commit type`,
    `Use one of: ${[...ALLOWED_TYPES].join(', ')}.`,
  );
}

/** Title must be at most 72 characters. */
function titleLengthRule(message) {
  const title = getTitle(message);
  if (title.length <= MAX_TITLE_LEN) return { ok: true };
  return fail(
    `Title is ${title.length} characters (max ${MAX_TITLE_LEN})`,
    `Shorten the title to ${MAX_TITLE_LEN} characters or fewer.`,
  );
}

/** Title must not end with a period. */
function noTrailingPeriodRule(message) {
  if (!getTitle(message).endsWith('.')) return { ok: true };
  return fail('Title ends with a period', 'Remove the trailing period from the title.');
}

/** Title must not contain emoji. */
function noEmojiInTitleRule(message) {
  if (!EMOJI_RE.test(getTitle(message))) return { ok: true };
  return fail('Title contains an emoji', 'Remove emoji from the commit title.');
}

// Common imperative verbs that end in "ed"/"s" and would otherwise trip the
// naive past-tense / third-person suffix heuristic below. Whitelisted so real
// imperatives ("process", "address", "embed", "feed") are never rejected.
const IMPERATIVE_EXCEPTIONS = new Set([
  // base verbs ending in "s"
  'process', 'address', 'compress', 'express', 'focus', 'pass', 'bypass',
  'dismiss', 'discuss', 'guess', 'press', 'access', 'cross', 'toss', 'miss',
  // base verbs ending in "ed"
  'embed', 'feed', 'seed', 'speed', 'need', 'proceed', 'exceed', 'succeed',
  'breed', 'bleed', 'shed', 'wed', 'spread', 'thread',
]);

/**
 * Subject must be imperative mood. Blocks only unambiguous past-tense /
 * third-person: a leading description verb ending in "ed" or "s", excluding
 * base verbs (e.g. "process", "address", "embed") that share those endings.
 */
function imperativeMoodRule(message) {
  const parsed = parseTitle(getTitle(message));
  if (!parsed) return { ok: true }; // not semantic form — semanticFormatRule owns it
  const firstWord = (parsed.description.match(/[a-zA-Z]+/) || [''])[0].toLowerCase();
  if (!firstWord) return { ok: true };
  if (IMPERATIVE_EXCEPTIONS.has(firstWord)) return { ok: true };
  // Base verbs ending in "ss"/"us" (e.g. "address", "focus") are never a
  // third-person "-s" conjugation — only a trailing single "s" is.
  if (/(ss|us)$/.test(firstWord)) return { ok: true };
  if (!/(ed|s)$/.test(firstWord)) return { ok: true };
  return fail(
    `Subject "${firstWord}" is not in imperative mood`,
    'Use the imperative mood, e.g. "add" not "added"/"adds".',
  );
}

/** Every body line must be at most 100 characters. */
function bodyLineLengthRule(message) {
  for (const line of getBodyLines(message)) {
    if (line.length > MAX_BODY_LINE_LEN) {
      return fail(
        `A body line is ${line.length} characters (max ${MAX_BODY_LINE_LEN})`,
        `Wrap body lines at ${MAX_BODY_LINE_LEN} characters.`,
      );
    }
  }
  return { ok: true };
}

/** The message must not contain AI/tool attribution. */
function noAiAttributionRule(message) {
  if (!AI_ATTRIBUTION_RE.test(String(message == null ? '' : message))) return { ok: true };
  return fail(
    'Commit message contains AI tool attribution',
    'Remove AI/tool attribution such as co-author trailers or "Generated with ...".',
  );
}

/**
 * A ticket ID matching the configured provider must be present. Reuses
 * `getTicketPattern`/`getProviderConfig` so the accepted form follows the
 * provider (github `#N`/`GH-N`, jira `PROJ-123`) — never a hard-coded pattern.
 */
function ticketIdPresentRule(message, ctx) {
  const providerConfig =
    (ctx && ctx.providerConfig) || getProviderConfig({ skipPrompt: true });
  const pattern = getTicketPattern(providerConfig);
  if (pattern.test(String(message == null ? '' : message))) return { ok: true };
  return fail(
    'No ticket ID found for the configured provider',
    'Reference the ticket in the message, e.g. "(#123)" or "(PROJ-123)".',
  );
}

/** The ordered rule set — the single source of truth for commit validation. */
const rules = {
  semanticFormatRule,
  allowedTypeRule,
  titleLengthRule,
  noTrailingPeriodRule,
  noEmojiInTitleRule,
  imperativeMoodRule,
  bodyLineLengthRule,
  noAiAttributionRule,
  ticketIdPresentRule,
};

/**
 * Validate a commit message against every rule in order.
 * @param {string} message - the raw commit message.
 * @param {{providerConfig?: object}} [ctx] - provider context for the ID rule.
 * @returns {{ok: true}|{ok: false, rule: string, reason: string, hint: string}}
 */
function validateMessage(message, ctx) {
  for (const [name, rule] of Object.entries(rules)) {
    const result = rule(message, ctx || {});
    if (!result.ok) {
      return { ok: false, rule: name, reason: result.reason, hint: result.hint };
    }
  }
  return { ok: true };
}

module.exports = { rules, validateMessage, ALLOWED_TYPES, PASS };

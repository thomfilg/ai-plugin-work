'use strict';

/**
 * identity-rules.js — the rules that read a name and an email, rather than a
 * body of text.
 *
 * Split from attribution.js because they answer a different question with a
 * different standard of proof. A commit message that merely NAMES a product is
 * ordinary engineering (`feat: add <vendor> adapter`); a `user.name` that
 * names one is not, because naming who wrote the commit is the entire purpose
 * of that field. One vocabulary, two readings — keeping them in one file made
 * every change to either look like a change to both.
 *
 * Three questions, in increasing strictness:
 *
 *   checkIdentity          is this a tool or a machine?     (always on)
 *   checkIdentityComplete  is this anybody at all?          (always on)
 *   checkExpectedIdentity  is this the RIGHT person?        (opt-in)
 *
 * The first two are blocklists and cannot tell one human from another. The
 * third can, and runs only when the operator has pinned who should be signing.
 */

const { AI_NAME_ALT, PASS, MAX_EVIDENCE_LEN, asText } = require('./attribution');

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
 * Whether an identity names a person at all.
 *
 * A commit needs BOTH halves. Miss one and git does not stop: unless
 * `user.useConfigOnly` is set it invents the pair from the account and the
 * hostname, and the commit lands as `root <root@a1b2c3d4e5f6>` — a machine's
 * byline, arrived at by omission rather than by claim. `checkIdentity` cannot
 * see that: a blank field names no tool and looks like no bot.
 *
 * Scoped to identities the guard actually RESOLVED. `resolved: false` means the
 * target could not be interrogated (no git, not a repository) — a command git
 * itself will refuse, and not a fact about the person running it.
 *
 * @param {{name?: string, email?: string, resolved?: boolean}} user
 */
/** The two halves, normalized once so the rule reads as one question. */
function identityFields(user) {
  const source = user || {};
  return { name: asText(source.name).trim(), email: asText(source.email).trim() };
}

function checkIdentityComplete(user) {
  if (user && user.resolved === false) return PASS;
  const { name, email } = identityFields(user);
  if (name && email) return PASS;
  const missing = [];
  if (!name) missing.push('user.name');
  if (!email) missing.push('user.email');
  return {
    ok: false,
    rule: 'missingIdentity',
    reason: `the commit would be authored with no ${missing.join(' and no ')}`,
    hint: 'Set the human author: git config user.name "Your Name" && git config user.email you@example.com',
    evidence: `${missing.join(' and ')} not configured`,
  };
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
  AI_IDENTITY_RE,
  BOT_IDENTITY_RES,
  checkIdentity,
  checkIdentityComplete,
  checkExpectedIdentity,
};

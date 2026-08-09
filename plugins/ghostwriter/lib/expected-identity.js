'use strict';

/**
 * expected-identity.js — who is allowed to sign, when the operator says so.
 *
 * The default rules are a blocklist: they answer "is this obviously a tool or
 * a machine?". That catches `<tool>`, `release-bot` and `…[bot]`, but it can
 * never catch a plainly-named app account, and it cannot tell one human from
 * another. An operator who wants the stronger guarantee — everything is signed
 * by ME — configures the expected identity here, and the guard switches from
 * "not obviously a machine" to "exactly this person".
 *
 * Configuration is environment-only and read from the HOOK's environment, for
 * the same reason the override is: a value the inspected command supplies is
 * not a policy, it is the thing being checked.
 *
 *   GHOSTWRITER_HUMAN_EMAIL=me@example.com,me@work.example
 *   GHOSTWRITER_HUMAN_LOGIN=my-github-login
 *
 * Unset (the default) leaves the blocklist behaviour exactly as it was.
 */

const EMAIL_ENV = 'GHOSTWRITER_HUMAN_EMAIL';
const LOGIN_ENV = 'GHOSTWRITER_HUMAN_LOGIN';

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The configured human, or empty lists when nothing is pinned.
 *
 * @param {object} env - the hook's own environment.
 * @returns {{emails: string[], logins: string[], configured: boolean}}
 */
function readExpectedIdentity(env) {
  const source = env || {};
  const emails = splitList(source[EMAIL_ENV]);
  const logins = splitList(source[LOGIN_ENV]);
  return { emails, logins, configured: emails.length > 0 || logins.length > 0 };
}

module.exports = { readExpectedIdentity, EMAIL_ENV, LOGIN_ENV };

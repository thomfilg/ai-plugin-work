'use strict';

/**
 * forge-guard.js — the passes that judge published prose and the account
 * publishing it.
 *
 * Split from guard.js so each file answers one question: guard.js owns what a
 * COMMIT says and who git stamps it as, this owns what a PULL REQUEST says and
 * who GitHub attributes it to. They share the rules and the finding shape;
 * neither needs to know how the other locates its text.
 *
 * The account pass is where this file's limits live. `gh` can be asked which
 * login it is using, so it is asked — but a token supplied by the command
 * replaces that login, and an MCP server holds a credential the guard cannot
 * see at all. Both are reported as unverifiable rather than waved through.
 */

const { checkText } = require('./attribution');
const { checkIdentity, checkExpectedIdentity } = require('./identity-rules');
const { finding, normalizeRead, UNVERIFIABLE } = require('./finding');

/** An identity that is unknown is not an identity that has been cleared. */
function unverifiableAccount(reason) {
  return {
    rule: 'unverifiableAccount',
    reason,
    hint: 'Log in as the human account, or unset the token override, so the poster can be checked.',
    evidence: '(no account resolved)',
  };
}

/** Literal text a post carries — a `--body` value, or an MCP `body` field. */
function checkPostLiterals(post) {
  for (const entry of post.texts) {
    const result = checkText(entry.text, { prose: true });
    if (!result.ok) return finding(result, entry.where);
  }
  return null;
}

/** Text a post loads from a file — `--body-file` and friends, read in full. */
function checkPostFiles(post, io) {
  for (const entry of post.textFiles) {
    if (!entry.file || entry.file.startsWith('-')) continue;
    const read = normalizeRead(io.readMessageFile(entry.file, io.cwd));
    const result = checkText(read.text, { prose: true });
    if (!result.ok) return finding(result, entry.where);
    if (read.truncated) return finding(UNVERIFIABLE, entry.where);
  }
  return null;
}

/** Prose passes — PR, issue and comment text, from the CLI or an MCP call. */
function checkPostText(posts, io) {
  for (const post of posts) {
    const hit = checkPostLiterals(post) || checkPostFiles(post, io);
    if (hit) return hit;
  }
  return null;
}

/** The raw command, in prose mode, for post bodies built by a heredoc. */
function checkRawPost(command, posts) {
  if (!posts.length) return null;
  const result = checkText(command, { prose: true });
  return result.ok ? null : finding(result, 'the command text');
}

/**
 * The account a `gh` post would be published under. A token supplied by the
 * command replaces the logged-in account, so the login the guard can read is
 * no longer the one that posts — that is unverifiable, not clean.
 */
function checkPostAccount(posts, io) {
  if (!posts.length) return null;
  const override = posts.find((post) => post.tokenOverride);
  if (override) {
    return finding(
      unverifiableAccount(
        `the command sets ${override.tokenOverride}, replacing the logged-in account`
      ),
      `gh ${override.kind}`
    );
  }
  const login = io.resolveAccount(io.cwd);
  if (!login) {
    if (!io.expected.configured) return null;
    return finding(
      unverifiableAccount('the posting account could not be read'),
      `gh ${posts[0].kind}`
    );
  }
  const identity = { name: login, email: '' };
  const result = checkIdentity(identity);
  if (!result.ok) return finding(result, `the account gh would post as (${login})`);
  const expected = checkExpectedIdentity(identity, io.expected);
  return expected.ok ? null : finding(expected, `the account gh would post as (${login})`);
}

module.exports = { checkPostText, checkRawPost, checkPostAccount, unverifiableAccount };

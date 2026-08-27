'use strict';

/**
 * guard.js — the decision: may this command, or this tool call, run?
 *
 * Two things get signed, and both are inspected: what a change SAYS, and who
 * it says wrote it. Each is checked at every place it can be written.
 *
 * A shell command is inspected in passes, most specific first, stopping at the
 * first finding so the operator sees the sharpest possible evidence:
 *
 *   1. message arguments  — `-m` / `--message` values
 *   2. message files      — `-F` / `--file` contents, and `<` redirects
 *   3. identity literals  — `--author`, `GIT_AUTHOR_NAME=…`, `git config user.*`,
 *                           `-c user.name=`, `GIT_CONFIG_KEY_n`, `--config-env`
 *   4. the raw command    — catches what the tokenizer cannot see through:
 *                           heredoc bodies, unquoted `$(…)`, chained writes
 *   5. published prose    — `gh pr/issue/release` bodies, titles and api fields
 *   6. the posting account— the account `gh` would publish as
 *   7. imported authorship— the byline and message inside a commit being
 *                           reused, or inside a patch `git am` would apply
 *   8. the repo identity  — what git would stamp, in the repository targeted
 *
 * A forge MCP call skips the parsing — its text arrives as named fields — and
 * is checked by the same rules. Its ACCOUNT cannot be checked at all: the
 * credential lives in the MCP server, not in the call.
 *
 * Pass 4 is why quoting tricks do not help. Pass 7 is why setting the identity
 * in an earlier session, or committing into another repository, does not
 * help. Anything the guard cannot read — an oversized file, an identity behind
 * an unreadable variable, an account replaced by a token — is reported as
 * unverifiable and refused, never assumed clean.
 *
 * All I/O is injectable. The hook supplies real readers; tests supply fakes,
 * so the decision logic is exercised without a git repository.
 */

const fs = require('node:fs');
const path = require('node:path');

const { scanCommand } = require('./git-surfaces');
const {
  checkMessageArgs,
  checkMessageFiles,
  checkIdentityLiterals,
  checkRawCommand,
  checkHookBypass,
  checkEffectiveIdentity,
} = require('./git-guard');
const {
  resolveGitUser,
  resolveCommitInfo,
  resolveGhAccount,
  resolveInstalledHook,
} = require('./git-identity');
const { scanForgeCommand, scanToolCall, scanToolFiles, invokesGh } = require('./forge-surfaces');
const {
  checkPostText,
  checkRawPost,
  checkPostAccount,
  unverifiableAccount,
} = require('./forge-guard');
const { checkCopiedCommits, checkStdinPatch, checkPatchFiles } = require('./imported-authorship');
const { readExpectedIdentity } = require('./expected-identity');
const { MAX_UNWRAP_DEPTH } = require('./command-scan');
const { finding, MAX_MESSAGE_FILE_BYTES } = require('./finding');
const { inspectFileWrites } = require('./file-content');
const { OVERRIDE_ENV, isOverridden } = require('./policy');
const { renderBlock } = require('./report');

/**
 * A `-F` target can be any file the caller names, so the read has to be
 * bounded — but a PARTIAL read is not a safe bound. Sampling the head, the
 * tail, or any other window leaves a region git will happily commit and the
 * guard never saw. So: read the whole file up to this limit (far past any real
 * commit message), and treat anything larger as UNVERIFIABLE rather than
 * clean. Blocking a 32 MiB commit message is not a cost worth optimising.
 */
const ALLOW = Object.freeze({ blocked: false });

/**
 * Fill `buffer` from `fd`, looping until it is full or the file ends.
 *
 * ONE `readSync` is allowed to return fewer bytes than asked for — a signal
 * arrives, the file lives on a network mount — and taking that prefix as the
 * whole file is the same mistake as sampling it: git reads the rest, the guard
 * does not. Stopping at a zero-length read is not that mistake; it is the end
 * of a file that shrank since the stat, and what was read IS all of it.
 *
 * @returns {number} bytes actually read.
 */
function readFully(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return offset;
}

/**
 * Read a message file in full.
 *
 * Three outcomes, and telling the last two apart is the whole point: the text,
 * `truncated` for a file too large to inspect, or `unreadable` with the errno
 * for one that is there and could not be read. Reporting that last case as an
 * empty string would make an unreadable file the cheapest way past every rule
 * in this plugin; `readFailure` decides which codes mean "nothing was there".
 *
 * Only REGULAR files are read. A FIFO — `git commit -F <(gen)` — reports size 0
 * and yields its bytes exactly once, so reading it would both clear the check
 * on an empty string and consume the data git was about to use. The open is
 * NON-BLOCKING for the same reason: opening a FIFO for reading otherwise waits
 * for a writer that may never arrive, and a guard that hangs is a guard that
 * gets removed. Regular files ignore the flag.
 *
 * @returns {{text: string, truncated?: boolean, unreadable?: string}}
 */
function readTextFile(filePath, cwd) {
  let fd;
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
    fd = fs.openSync(path.resolve(cwd || process.cwd(), filePath), flags);
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) return { text: '', unreadable: 'EISDIR' };
    if (!stat.isFile()) return { text: '', unreadable: 'ENOTREG' };
    if (stat.size > MAX_MESSAGE_FILE_BYTES) return { text: '', truncated: true };
    const buffer = Buffer.alloc(stat.size);
    return { text: buffer.toString('utf8', 0, readFully(fd, buffer)) };
  } catch (err) {
    return { text: '', unreadable: (err && err.code) || 'EUNKNOWN' };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* the descriptor is going away with the process anyway */
      }
    }
  }
}

/** The real readers, overridden wholesale by a caller that supplies fakes. */
const IO_DEFAULTS = Object.freeze({
  readMessageFile: readTextFile,
  resolveIdentity: resolveGitUser,
  resolveCommitInfo,
  resolveAccount: resolveGhAccount,
  resolveInstalledHook,
});

function defaultIo(io) {
  const opts = io || {};
  const env = opts.env || process.env;
  return {
    ...IO_DEFAULTS,
    ...opts,
    cwd: opts.cwd || process.cwd(),
    env,
    expected: opts.expected || readExpectedIdentity(env),
  };
}

/** A command nested past the traversal cap was never inspected at all. */
function checkUnverifiableSurfaces(surfaces, posts) {
  const buried = [...surfaces, ...posts].find((surface) => surface.unverifiable);
  if (!buried) return null;
  return finding(
    {
      rule: 'unverifiableCommand',
      reason: 'the command is nested too deeply in wrappers to inspect',
      hint: 'Run the git or gh command directly instead of through nested shells.',
      evidence: `wrapper depth beyond ${MAX_UNWRAP_DEPTH}`,
    },
    'the command text'
  );
}

/**
 * The ordered passes, sharpest evidence first. Kept as a list so the order is
 * a readable fact rather than the shape of a boolean chain.
 */
const COMMAND_PASSES = [
  (c) => checkUnverifiableSurfaces(c.surfaces, c.posts),
  (c) => checkMessageArgs(c.surfaces),
  (c) => checkMessageFiles(c.surfaces, c.ctx),
  (c) => checkIdentityLiterals(c.surfaces, c.ctx),
  (c) => checkRawCommand(c.command, c.surfaces),
  (c) => checkPostText(c.posts, c.ctx),
  (c) => checkRawPost(c.command, c.posts, c.reachesForge),
  (c) => checkPostAccount(c.posts, c.ctx),
  (c) => checkCopiedCommits(c.surfaces, c.ctx),
  (c) => checkStdinPatch(c.surfaces),
  (c) => checkPatchFiles(c.surfaces, c.ctx),
  (c) => checkHookBypass(c.surfaces, c.ctx),
  (c) => checkEffectiveIdentity(c.surfaces, c.ctx),
];

/** The first pass that finds something, or null when every pass is clean. */
function firstFinding(passes, context) {
  for (const pass of passes) {
    const hit = pass(context);
    if (hit) return hit;
  }
  return null;
}

/**
 * Decide whether a command may run.
 *
 * @param {string} command - the raw Bash tool input.
 * @param {object} [io] - injectable `{cwd, env, readMessageFile, resolveIdentity}`.
 * @returns {{blocked: false}|{blocked: true, rule: string, reason: string,
 *   hint: string, evidence: string, where: string, selfGranted?: boolean}}
 */
function inspectCommand(command, io) {
  const ctx = defaultIo(io);
  const { surfaces } = scanCommand(command);
  const posts = scanForgeCommand(command).surfaces;
  // A `gh` invocation the classifier did not recognise as a post is still a
  // `gh` invocation. Locating the command group depends on knowing which
  // options consume a value, and that knowledge goes stale; the raw pass does
  // not depend on it, so it is given the chance to run.
  const reachesForge = invokesGh(command);
  if (!surfaces.length && !posts.length && !reachesForge) return ALLOW;

  // An override the command sets for itself is not an override — it is the
  // thing the guard exists to prevent, spelled differently. Only the hook's
  // inherited environment can lift the rules.
  const selfGranted = String(command).includes(OVERRIDE_ENV);
  if (!selfGranted && isOverridden(ctx.env)) return ALLOW;

  const hit = firstFinding(COMMAND_PASSES, { command, surfaces, posts, reachesForge, ctx });
  if (!hit) return ALLOW;
  return selfGranted ? { ...hit, selfGranted: true } : hit;
}

/**
 * Decide whether a forge MCP tool call may run.
 *
 * The text is inspected exactly as the CLI path's is. The posting ACCOUNT is
 * not: the credential lives in the MCP server, so no inspection of the call
 * can reveal who it will post as. When an expected human is configured that
 * gap is refused rather than assumed away.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} [io]
 */
function inspectToolCall(toolName, toolInput, io) {
  const ctx = defaultIo(io);
  const { surfaces } = scanToolCall(toolName, toolInput);
  // `push_files` and `create_or_update_file` commit CONTENT through the API,
  // which no message pass would ever see.
  const files = scanToolFiles(toolName, toolInput);
  if (!surfaces.length && !files.length) return ALLOW;
  if (isOverridden(ctx.env)) return ALLOW;
  const written = inspectFileWrites(files, ctx);
  const hit = checkPostText(surfaces, ctx) || (written.blocked ? written : null);
  if (hit) return hit;
  if (!surfaces.length || !ctx.expected.configured) return ALLOW;
  return finding(
    unverifiableAccount(
      "an MCP tool posts under the server's credential, which the guard cannot read"
    ),
    toolName
  );
}

/**
 * Decide whether a file write may run.
 *
 * The other two entry points inspect text ABOUT a change. This one inspects
 * the change: a footer in a source comment ships in the diff, appears in the
 * pull request, and stays in the tree long after the message has scrolled away.
 *
 * @param {Array<{path: string, text: string}>} files
 * @param {object} [io]
 */
function inspectWrite(files, io) {
  const ctx = defaultIo(io);
  if (!files || !files.length) return ALLOW;
  if (isOverridden(ctx.env)) return ALLOW;
  return inspectFileWrites(files, ctx);
}

module.exports = {
  inspectCommand,
  inspectToolCall,
  inspectWrite,
  renderBlock,
  readTextFile,
  readFully,
  OVERRIDE_ENV,
  MAX_MESSAGE_FILE_BYTES,
};

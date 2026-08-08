'use strict';

/**
 * guard.js — the decision: may this command, this tool call, or this write run?
 *
 * Three things get signed, and all three are inspected: what a change SAYS,
 * what it CARRIES, and who it says wrote it. Each is checked at every place it
 * can be written. The rules live in attribution.js, identity-rules.js and
 * file-content.js; the passes live in git-guard.js and forge-guard.js; this
 * file owns only which passes run, and in what order.
 *
 * A shell command is inspected most-specific first, stopping at the first
 * finding so the operator sees the sharpest possible evidence:
 *
 *   1. message arguments  — `-m` / `--message` values
 *   2. message files      — `-F` / `--file` contents, and `<` redirects
 *   3. identity literals  — `--author`, `GIT_AUTHOR_NAME=…`, `git config user.*`,
 *                           `-c user.name=`, `GIT_CONFIG_KEY_n`, `--config-env`
 *   4. the raw command    — catches what the tokenizer cannot see through:
 *                           heredoc bodies, unquoted `$(…)`, chained writes
 *   5. published prose    — `gh pr/issue/release` bodies, titles and api fields
 *   6. the posting account— the account `gh` would publish as
 *   7. copied commits     — the author AND message a reuse brings along
 *   8. imported patches   — the `From:` header and body of a `git am`
 *   9. the repo identity  — what git would stamp, in the repository targeted
 *  10. the backstop       — whether the command switches the hooks off
 *
 * A forge MCP call skips the parsing — its text and its files arrive as named
 * fields — and is checked by the same rules. Its ACCOUNT cannot be checked at
 * all: the credential lives in the MCP server, not in the call.
 *
 * A write tool is simpler still: it names a file and the text going into it.
 *
 * Pass 4 is why quoting tricks do not help. Pass 9 is why setting the identity
 * in an earlier session, or committing into another repository, does not
 * help. Anything the guard cannot read — an oversized file, an identity behind
 * an unreadable variable, a patch on a pipe, an account replaced by a token —
 * is reported as unverifiable and refused, never assumed clean.
 *
 * All I/O is injectable. The hook supplies real readers; tests supply fakes,
 * so the decision logic is exercised without a git repository.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  resolveGitUser,
  resolveCommitInfo,
  resolveGhAccount,
  resolveInstalledHook,
} = require('./git-identity');
const { scanForgeCommand, scanToolCall, scanToolFiles } = require('./forge-surfaces');
const { inspectFileWrites } = require('./file-content');
const { scanCommand } = require('./git-surfaces');
const {
  checkPostText,
  checkRawPost,
  checkPostAccount,
  unverifiableAccount,
} = require('./forge-guard');
const {
  checkMessageArgs,
  checkMessageFiles,
  checkIdentityLiterals,
  checkRawCommand,
  checkCopiedCommits,
  checkPatchFiles,
  checkHookBypass,
  checkEffectiveIdentity,
} = require('./git-guard');
const { readExpectedIdentity } = require('./expected-identity');
const { MAX_UNWRAP_DEPTH } = require('./command-scan');
const { finding, MAX_MESSAGE_FILE_BYTES } = require('./finding');
const { OVERRIDE_ENV, isOverridden } = require('./policy');
const { renderBlock } = require('./report');

const ALLOW = Object.freeze({ blocked: false });

/**
 * Read a message file IN FULL.
 *
 * A `-F` target can be any file the caller names, so the read has to be
 * bounded — but a PARTIAL read is not a safe bound. Sampling the head, the
 * tail, or any other window leaves a region git will happily commit and the
 * guard never saw. So: the whole file up to MAX_MESSAGE_FILE_BYTES, and
 * anything larger reported as unverifiable rather than clean. Blocking a
 * 32 MiB commit message is not a cost worth optimising.
 *
 * @returns {{text: string, truncated: boolean, unreadable?: boolean}} neither
 *   flag ever means "part of it was checked and passed".
 */
function readTextFile(filePath, cwd) {
  let fd;
  try {
    fd = fs.openSync(path.resolve(cwd || process.cwd(), filePath), 'r');
    const { size } = fs.fstatSync(fd);
    if (size > MAX_MESSAGE_FILE_BYTES) return { text: '', truncated: true };
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return { text: buffer.toString('utf8', 0, read), truncated: false };
  } catch (err) {
    // A file that is NOT THERE is a command git will refuse itself, so there
    // is nothing to guard. Any other failure — a directory, a permission, a
    // short read — is a file git may well read fine while the guard saw none
    // of it, and an empty string reads as clean.
    return { text: '', truncated: false, unreadable: err.code !== 'ENOENT' };
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

/**
 * The real readers. Every one is replaceable, which is how the decision logic
 * is exercised without a git repository, a `gh` login, or a filesystem.
 */
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
  (c) => checkRawPost(c.command, c.posts),
  (c) => checkPostAccount(c.posts, c.ctx),
  (c) => checkCopiedCommits(c.surfaces, c.ctx),
  (c) => checkPatchFiles(c.surfaces, c.ctx),
  (c) => checkEffectiveIdentity(c.surfaces, c.ctx),
  (c) => checkHookBypass(c.surfaces, c.ctx),
];

/** A verdict as a finding-or-null, so it composes with the pass helpers. */
function nullIfAllowed(verdict) {
  return verdict && verdict.blocked ? verdict : null;
}

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
  if (!surfaces.length && !posts.length) return ALLOW;

  // An override the command sets for itself is not an override — it is the
  // thing the guard exists to prevent, spelled differently. Only the hook's
  // inherited environment can lift the rules.
  const selfGranted = String(command).includes(OVERRIDE_ENV);
  if (!selfGranted && isOverridden(ctx.env)) return ALLOW;

  const hit = firstFinding(COMMAND_PASSES, { command, surfaces, posts, ctx });
  if (!hit) return ALLOW;
  return selfGranted ? { ...hit, selfGranted: true } : hit;
}

/**
 * Decide whether a forge MCP tool call may run.
 *
 * The text is inspected exactly as the CLI path's is, and so is any FILE the
 * call carries: `create_or_update_file` and `push_files` commit content
 * without a working tree or a shell, so the command walker never sees them and
 * the file rules have to be applied to the call itself. The posting ACCOUNT is
 * the one thing that cannot be inspected: the credential lives in the MCP
 * server, so no reading of the call can reveal who it will post as. When an
 * expected human is configured that gap is refused rather than assumed away.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} [io]
 */
function inspectToolCall(toolName, toolInput, io) {
  const ctx = defaultIo(io);
  const { surfaces } = scanToolCall(toolName, toolInput);
  const files = scanToolFiles(toolName, toolInput);
  if (!surfaces.length && !files.length) return ALLOW;
  if (isOverridden(ctx.env)) return ALLOW;
  const hit = checkPostText(surfaces, ctx) || nullIfAllowed(inspectFileWrites(files, ctx));
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
 * Decide whether a file write may proceed.
 *
 * The other entry points ask what a change SAYS about itself in the places a
 * change is announced. This one asks the same question of the change itself:
 * a footer written into a source file ships in the diff, appears in the pull
 * request, and stays in the tree after both are forgotten.
 *
 * @param {Array<{path: string, text: string}>} files - see file-content.js
 *   `writeFiles`, which builds these from a write tool's input.
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
  OVERRIDE_ENV,
  MAX_MESSAGE_FILE_BYTES,
};

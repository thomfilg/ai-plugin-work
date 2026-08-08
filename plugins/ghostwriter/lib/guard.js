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
 *   7. the repo identity  — what git would stamp, in the repository targeted
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

const { checkText } = require('./attribution');
const { checkIdentity, checkIdentityComplete, checkExpectedIdentity } = require('./identity-rules');
const { scanCommand, identityEntry } = require('./git-surfaces');
const { resolveGitUser, resolveCommitInfo, resolveGhAccount } = require('./git-identity');
const { scanForgeCommand, scanToolCall, scanToolFiles } = require('./forge-surfaces');
const { inspectFileWrites } = require('./file-content');
const {
  checkPostText,
  checkRawPost,
  checkPostAccount,
  unverifiableAccount,
} = require('./forge-guard');
const { readExpectedIdentity } = require('./expected-identity');
const { MAX_UNWRAP_DEPTH } = require('./command-scan');
const { finding, normalizeRead, UNVERIFIABLE, MAX_MESSAGE_FILE_BYTES } = require('./finding');
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
 * Read a message file in full.
 *
 * @returns {{text: string, truncated: boolean}} `truncated` means the file was
 *   too large to inspect — never that part of it was checked and passed.
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
  } catch {
    return { text: '', truncated: false };
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

function defaultIo(io) {
  const opts = io || {};
  return {
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
    readMessageFile: opts.readMessageFile || ((p, cwd) => readTextFile(p, cwd)),
    resolveIdentity: opts.resolveIdentity || resolveGitUser,
    resolveCommitInfo: opts.resolveCommitInfo || resolveCommitInfo,
    resolveAccount: opts.resolveAccount || resolveGhAccount,
    expected: opts.expected || readExpectedIdentity(opts.env || process.env),
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

/** Pass 1 — every `-m` / `--message` value on every authoring surface. */
function checkMessageArgs(surfaces) {
  for (const surface of surfaces) {
    for (const message of surface.messages) {
      const result = checkText(message);
      if (!result.ok) return finding(result, `git ${surface.kind} message`);
    }
  }
  return null;
}

/**
 * The directory this surface actually operates on. `git -C <dir> commit` reads
 * its config — and resolves a relative `-F` path — from there, not from the
 * shell's cwd, so both later passes have to follow it.
 */
function surfaceCwd(surface, io) {
  // `-C` compounds, so every value applies in order: `-C outer -C inner`
  // lands in outer/inner. path.resolve does exactly that, absolutes included.
  return surface.dirs && surface.dirs.length ? path.resolve(io.cwd, ...surface.dirs) : io.cwd;
}

/**
 * The repository whose config this surface commits under. `--git-dir` /
 * `GIT_DIR` select it independently of the process directory, so a command can
 * sit in a clean repo and author into another one.
 */
function surfaceGitDir(surface, io) {
  // A GIT_DIR already exported in the session reaches git without appearing in
  // the command at all. The guard's own `git config` read inherits it too, so
  // the two agree either way — but threading it explicitly makes that a stated
  // contract rather than a coincidence, and keeps it right if the guard's
  // environment ever stops matching the command's.
  const selected = surface.gitDir || io.env.GIT_DIR;
  return selected ? path.resolve(surfaceCwd(surface, io), selected) : null;
}

/** Pass 2 — every `-F` / `--file` / redirected message body, read in full. */
function checkMessageFiles(surfaces, io) {
  for (const surface of surfaces) {
    for (const file of surface.messageFiles) {
      if (!file || file.startsWith('-')) continue;
      const where = `git ${surface.kind} message file ${file}`;
      const read = normalizeRead(io.readMessageFile(file, surfaceCwd(surface, io)));
      const result = checkText(read.text);
      if (!result.ok) return finding(result, where);
      if (read.truncated) return finding(UNVERIFIABLE, where);
    }
  }
  return null;
}

/**
 * An identity recorded as a REFERENCE (`--config-env=user.name=VAR`) resolved
 * against the guard's environment, or null when the variable is not visible.
 */
function resolveIdentityRef(identity, io) {
  if (!identity.envVar) return identity;
  const value = io.env[identity.envVar];
  if (value === undefined) return null;
  return identityEntry(identity.source, identity.key, value);
}

/** A referenced identity nobody can read is not an identity anyone can clear. */
function unverifiableIdentity(identity) {
  return {
    rule: 'unverifiableIdentity',
    reason: `the committing identity comes from $${identity.envVar}, which the guard cannot read`,
    hint: 'Set user.name/user.email directly so the identity can be checked.',
    evidence: `${identity.source}=${identity.envVar}`,
  };
}

/** Pass 3 — identities written by the command itself. */
function checkIdentityLiterals(surfaces, io) {
  for (const surface of surfaces) {
    for (const identity of surface.identities) {
      const where = `${identity.source} on git ${surface.kind}`;
      const resolved = resolveIdentityRef(identity, io);
      if (!resolved) return finding(unverifiableIdentity(identity), where);
      const result = checkIdentity(resolved);
      if (!result.ok) return finding(result, where);
    }
  }
  return null;
}

/** Pass 4 — the raw command text, for bodies the tokenizer cannot reach. */
function checkRawCommand(command, surfaces) {
  if (!surfaces.some((surface) => surface.writesMessage)) return null;
  const result = checkText(command);
  return result.ok ? null : finding(result, 'the command text');
}

/**
 * A copied commit — `git cherry-pick <ref>`, `git commit -C <ref>`.
 *
 * BOTH halves ride along: the source commit's author, which the configured
 * identity pass would never see, and its message, which none of the message
 * passes receive because it appears nowhere in the command. Checking one and
 * not the other leaves exactly half the copy uninspected.
 */
function checkCopiedCommit(surface, ref, io) {
  const cwd = surfaceCwd(surface, io);
  const source = io.resolveCommitInfo(cwd, surfaceGitDir(surface, io), ref);
  const author = checkIdentity(source);
  if (!author.ok) return finding(author, `the author copied from ${ref}`);
  const expected = checkExpectedIdentity(source, io.expected);
  if (!expected.ok) return finding(expected, `the author copied from ${ref}`);
  const message = checkText(source.message);
  if (!message.ok) return finding(message, `the message copied from ${ref}`);
  return null;
}

function checkCopiedCommits(surfaces, io) {
  for (const surface of surfaces) {
    for (const ref of surface.authorRefs || []) {
      const hit = checkCopiedCommit(surface, ref, io);
      if (hit) return hit;
    }
  }
  return null;
}

/** Pass 5 — the identity git would stamp on the object being written. */
function checkEffectiveIdentity(surfaces, io) {
  const seen = new Set();
  for (const surface of surfaces) {
    if (!surface.writesCommit) continue;
    const cwd = surfaceCwd(surface, io);
    const gitDir = surfaceGitDir(surface, io);
    const key = `${cwd}\u0000${gitDir || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const user = io.resolveIdentity(cwd, gitDir, surface.configSources);
    const result = checkIdentity(user);
    if (!result.ok) return finding(result, 'the configured git identity');
    // An identity that names nobody is checked BEFORE the expected-human pass:
    // "you set no email" is the actionable sentence, and `unexpectedIdentity`
    // reporting `(no identity resolved)` would bury it.
    const complete = checkIdentityComplete(user);
    if (!complete.ok) return finding(complete, 'the configured git identity');
    const expected = checkExpectedIdentity(user, io.expected);
    if (!expected.ok) return finding(expected, 'the configured git identity');
  }
  return null;
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
  (c) => checkEffectiveIdentity(c.surfaces, c.ctx),
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

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

const { checkText, checkIdentity, checkExpectedIdentity } = require('./attribution');
const { scanCommand, identityEntry } = require('./git-surfaces');
const { resolveGitUser, resolveCommitInfo, resolveGhAccount } = require('./git-identity');
const { scanForgeCommand, scanToolCall } = require('./forge-surfaces');
const {
  checkPostText,
  checkRawPost,
  checkPostAccount,
  unverifiableAccount,
} = require('./forge-guard');
const { checkCopiedCommits, checkStdinPatch, checkPatchFiles } = require('./imported-authorship');
const { surfaceCwd, surfaceGitDir } = require('./surface-target');
const { readExpectedIdentity } = require('./expected-identity');
const { MAX_UNWRAP_DEPTH } = require('./command-scan');
const { finding, normalizeRead, readFailure, MAX_MESSAGE_FILE_BYTES } = require('./finding');

/** Operator override, honoured ONLY from the hook's own environment. */
const OVERRIDE_ENV = 'GHOSTWRITER_ALLOW_ATTRIBUTION';

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

/** Pass 2 — every `-F` / `--file` / redirected message body, read in full. */
function checkMessageFiles(surfaces, io) {
  for (const surface of surfaces) {
    for (const file of surface.messageFiles) {
      if (!file || file.startsWith('-')) continue;
      const where = `git ${surface.kind} message file ${file}`;
      const read = normalizeRead(io.readMessageFile(file, surfaceCwd(surface, io)));
      const result = checkText(read.text);
      if (!result.ok) return finding(result, where);
      const failed = readFailure(read, where);
      if (failed) return failed;
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
  (c) => checkStdinPatch(c.surfaces),
  (c) => checkPatchFiles(c.surfaces, c.ctx),
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
  if (!surfaces.length && !posts.length) return ALLOW;

  // An override the command sets for itself is not an override — it is the
  // thing the guard exists to prevent, spelled differently. Only the hook's
  // inherited environment can lift the rules.
  const selfGranted = String(command).includes(OVERRIDE_ENV);
  if (!selfGranted && ctx.env[OVERRIDE_ENV] === '1') return ALLOW;

  const hit = firstFinding(COMMAND_PASSES, { command, surfaces, posts, ctx });
  if (!hit) return ALLOW;
  return selfGranted ? { ...hit, selfGranted: true } : hit;
}

/** Render a finding as the stderr block the runtime shows the agent. */
function renderBlock(hit) {
  const lines = [
    'ghostwriter: this command would sign the work as an AI.',
    '',
    `  rule      ${hit.rule}`,
    `  where     ${hit.where}`,
    `  problem   ${hit.reason}`,
    `  evidence  ${hit.evidence}`,
    '',
    `↳ Fix: ${hit.hint}`,
    '',
    'The change belongs to the person who asked for it. Tools do not get a byline.',
  ];
  if (hit.selfGranted) {
    lines.push(
      '',
      `Note: ${OVERRIDE_ENV} set inside the command is ignored — the override is`,
      "honoured only from the operator's own environment."
    );
  }
  return `${lines.join('\n')}\n`;
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
  if (!surfaces.length) return ALLOW;
  if (ctx.env[OVERRIDE_ENV] === '1') return ALLOW;
  const hit = checkPostText(surfaces, ctx);
  if (hit) return hit;
  if (!ctx.expected.configured) return ALLOW;
  return finding(
    unverifiableAccount(
      "an MCP tool posts under the server's credential, which the guard cannot read"
    ),
    toolName
  );
}

module.exports = {
  inspectCommand,
  inspectToolCall,
  renderBlock,
  readTextFile,
  readFully,
  OVERRIDE_ENV,
  MAX_MESSAGE_FILE_BYTES,
};

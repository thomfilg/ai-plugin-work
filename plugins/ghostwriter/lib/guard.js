'use strict';

/**
 * guard.js — the decision: may this shell command run?
 *
 * The guard inspects a command in five passes, most specific first, and stops
 * at the first finding so the operator sees the sharpest possible evidence:
 *
 *   1. message arguments  — `-m` / `--message` values
 *   2. message files      — `-F` / `--file` contents
 *   3. identity literals  — `--author`, `GIT_AUTHOR_NAME=…`, `git config user.*`
 *   4. the raw command    — catches what the tokenizer cannot see through:
 *                           heredoc bodies, unquoted `$(…)`, chained writes
 *   5. the repo identity  — what `git config user.name/user.email` resolves to
 *
 * Pass 4 is why quoting tricks do not help: the same shape-specific rules run
 * over the whole command text. Pass 5 is why setting the identity in an
 * earlier session does not help either.
 *
 * All I/O is injectable. The hook supplies real readers; tests supply fakes,
 * so the decision logic is exercised without a git repository.
 */

const fs = require('node:fs');
const path = require('node:path');

const { checkText, checkIdentity } = require('./attribution');
const { scanCommand } = require('./git-surfaces');
const { resolveGitUser } = require('./git-identity');

/** Operator override, honoured ONLY from the hook's own environment. */
const OVERRIDE_ENV = 'GHOSTWRITER_ALLOW_ATTRIBUTION';

/**
 * Message files are read whole up to this size. Past it only the head and the
 * tail are read — a bounded read is necessary (a `-F` target can be any file
 * the caller names), but reading only the HEAD would be the wrong bound:
 * trailers and tool footers live at the END of a message.
 */
const MAX_MESSAGE_FILE_BYTES = 1024 * 1024;
const EDGE_BYTES = 128 * 1024;
const ALLOW = Object.freeze({ blocked: false });

/** Read `count` bytes of an open file starting at `position`. */
function readChunk(fd, position, count) {
  const buffer = Buffer.alloc(count);
  const read = fs.readSync(fd, buffer, 0, count, position);
  return buffer.toString('utf8', 0, read);
}

function readTextFile(filePath, cwd) {
  let fd;
  try {
    fd = fs.openSync(path.resolve(cwd || process.cwd(), filePath), 'r');
    const { size } = fs.fstatSync(fd);
    if (size <= MAX_MESSAGE_FILE_BYTES) return readChunk(fd, 0, size);
    // Head and tail, joined by a newline so neither edge can splice a false
    // match across the gap.
    return `${readChunk(fd, 0, EDGE_BYTES)}\n${readChunk(fd, size - EDGE_BYTES, EDGE_BYTES)}`;
  } catch {
    return '';
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
  };
}

function finding(result, where) {
  return {
    blocked: true,
    rule: result.rule,
    reason: result.reason,
    hint: result.hint,
    evidence: result.evidence,
    where,
  };
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
  return surface.dir ? path.resolve(io.cwd, surface.dir) : io.cwd;
}

/** Pass 2 — every `-F` / `--file` / redirected message body we can read. */
function checkMessageFiles(surfaces, io) {
  for (const surface of surfaces) {
    for (const file of surface.messageFiles) {
      if (!file || file.startsWith('-')) continue;
      const result = checkText(io.readMessageFile(file, surfaceCwd(surface, io)));
      if (!result.ok) return finding(result, `git ${surface.kind} message file ${file}`);
    }
  }
  return null;
}

/** Pass 3 — identities written by the command itself. */
function checkIdentityLiterals(surfaces) {
  for (const surface of surfaces) {
    for (const identity of surface.identities) {
      const result = checkIdentity(identity);
      if (!result.ok) return finding(result, `${identity.source} on git ${surface.kind}`);
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
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    const result = checkIdentity(io.resolveIdentity(cwd));
    if (!result.ok) return finding(result, 'the configured git identity');
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
  if (!surfaces.length) return ALLOW;

  // An override the command sets for itself is not an override — it is the
  // thing the guard exists to prevent, spelled differently. Only the hook's
  // inherited environment can lift the rules.
  const selfGranted = String(command).includes(OVERRIDE_ENV);
  if (!selfGranted && ctx.env[OVERRIDE_ENV] === '1') return ALLOW;

  const hit =
    checkMessageArgs(surfaces) ||
    checkMessageFiles(surfaces, ctx) ||
    checkIdentityLiterals(surfaces) ||
    checkRawCommand(command, surfaces) ||
    checkEffectiveIdentity(surfaces, ctx);
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

module.exports = {
  inspectCommand,
  renderBlock,
  readTextFile,
  OVERRIDE_ENV,
  MAX_MESSAGE_FILE_BYTES,
};

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
const { scanCommand, identityEntry } = require('./git-surfaces');
const { resolveGitUser } = require('./git-identity');

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
const MAX_MESSAGE_FILE_BYTES = 32 * 1024 * 1024;
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

/** Accept either shape from an injected reader: a plain string or the record. */
function normalizeRead(value) {
  if (typeof value === 'string') return { text: value, truncated: false };
  return { text: (value && value.text) || '', truncated: Boolean(value && value.truncated) };
}

/** A file the guard could not read in full is not a file it can clear. */
const UNVERIFIABLE = Object.freeze({
  rule: 'unverifiableMessage',
  reason: 'the message file is too large to inspect in full',
  hint: 'Shorten the message file so the guard can read all of it.',
  evidence: `larger than ${MAX_MESSAGE_FILE_BYTES} bytes`,
});

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
    checkIdentityLiterals(surfaces, ctx) ||
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

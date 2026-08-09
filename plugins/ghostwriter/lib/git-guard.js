'use strict';

/**
 * git-guard.js — the passes that judge a git command.
 *
 * Split from guard.js so each file answers one question: this owns what a
 * COMMIT says and who git will stamp it as, forge-guard.js owns what a PULL
 * REQUEST says and who GitHub will attribute it to, and guard.js owns only the
 * order they run in. They share the rules and the finding shape; neither needs
 * to know how the other locates its text.
 *
 * Two ideas run through every pass here. The first is that the REPOSITORY a
 * command targets is not necessarily the one the shell is standing in — `-C`,
 * `--git-dir` and `GIT_DIR` each move it, so every lookup resolves the target
 * first. The second is that what cannot be read is refused: an oversized
 * message file, an identity behind an invisible variable, a patch arriving on
 * a pipe. An empty read is not a clean read.
 */

const { checkText } = require('./attribution');
const { checkIdentity, checkIdentityComplete, checkExpectedIdentity } = require('./identity-rules');
const { identityEntry } = require('./git-surfaces');
const { finding, normalizeRead, readFailure } = require('./finding');
const { surfaceCwd, surfaceGitDir } = require('./surface-target');

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

/**
 * The backstop pass — is this command removing the layer below?
 *
 * `--no-verify` and `-c core.hooksPath=…` skip the repository's hooks, and one
 * of those hooks is the only thing that reads a message AFTER the shell has
 * expanded it. Skipping somebody else's slow linter is ordinary work, so the
 * question asked is the narrow one: is ghostwriter's own commit-msg hook
 * installed here? Only then is there a backstop being removed.
 */
function checkHookBypass(surfaces, io) {
  for (const surface of surfaces) {
    if (!surface.bypassesHooks || !surface.writesCommit) continue;
    if (!io.resolveInstalledHook(surfaceCwd(surface, io), surfaceGitDir(surface, io))) continue;
    return finding(
      {
        rule: 'hookBypass',
        reason: "the command skips the repository's hooks, including the commit-msg backstop",
        hint: 'Drop the flag. That hook is the only layer that sees a message after the shell expands it.',
        evidence: surface.bypassesHooks,
      },
      `git ${surface.kind}`
    );
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
    // An identity that names NOBODY is the one this pass used to clear: a
    // blank field matches no tool and looks like no bot, and git fills the
    // gap itself with `account@hostname`.
    const complete = checkIdentityComplete(user);
    if (!complete.ok) return finding(complete, 'the configured git identity');
    const expected = checkExpectedIdentity(user, io.expected);
    if (!expected.ok) return finding(expected, 'the configured git identity');
  }
  return null;
}

module.exports = {
  checkMessageArgs,
  checkMessageFiles,
  checkIdentityLiterals,
  checkRawCommand,
  checkHookBypass,
  checkEffectiveIdentity,
};

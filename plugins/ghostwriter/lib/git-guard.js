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

const path = require('node:path');

const { checkText } = require('./attribution');
const { checkIdentity, checkIdentityComplete, checkExpectedIdentity } = require('./identity-rules');
const { identityEntry, parseAuthorSpec, PATCH_SUBCOMMANDS } = require('./git-surfaces');
const { finding, normalizeRead, UNVERIFIABLE, UNREADABLE } = require('./finding');

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

/** One message file: what it says, or why it could not be read. */
function checkMessageFile(surface, file, io) {
  const where = `git ${surface.kind} message file ${file}`;
  const read = normalizeRead(io.readMessageFile(file, surfaceCwd(surface, io)));
  const result = checkText(read.text);
  if (!result.ok) return finding(result, where);
  if (read.truncated) return finding(UNVERIFIABLE, where);
  if (read.unreadable) return finding(UNREADABLE, where);
  return null;
}

/** Pass 2 — every `-F` / `--file` / redirected message body, read in full. */
function checkMessageFiles(surfaces, io) {
  for (const surface of surfaces) {
    for (const file of surface.messageFiles) {
      // A `-` here is stdin, not a path: nothing to open, and the redirect
      // that feeds it was collected as a file of its own.
      if (!file || file.startsWith('-')) continue;
      const hit = checkMessageFile(surface, file, io);
      if (hit) return hit;
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

/**
 * An imported patch — `git am <patch>`.
 *
 * `am` takes the author from the patch's `From:` header and the message from
 * its body, so the configured identity describes the committer and nothing
 * describes the AUTHOR that lands. Read with the FILE rules: a patch is mostly
 * a diff, and a diff is file content.
 */
const PATCH_AUTHOR_RE = /^From:[ \t]*(.+)$/im;

function checkPatchFile(surface, file, io) {
  const where = `git ${surface.kind} patch ${file}`;
  const read = normalizeRead(io.readMessageFile(file, surfaceCwd(surface, io)));
  if (read.truncated) return finding(UNVERIFIABLE, where);
  if (read.unreadable) return finding(UNREADABLE, where);
  const header = PATCH_AUTHOR_RE.exec(read.text);
  if (header) {
    const author = checkIdentity(parseAuthorSpec(header[1]));
    if (!author.ok) return finding(author, `the author imported from ${file}`);
  }
  const body = checkText(read.text, { file: true });
  return body.ok ? null : finding(body, where);
}

function checkPatchFiles(surfaces, io) {
  for (const surface of surfaces) {
    if (!PATCH_SUBCOMMANDS.has(surface.kind)) continue;
    // No file and no redirect means the patch arrives on stdin, from a pipe
    // the guard cannot see. An import whose author nobody read is the case
    // this pass exists for, so it is refused rather than assumed clean —
    // unless the command is RESUMING an import, where there is no patch to
    // name and every other pass still applies.
    if (surface.resumesPatch) continue;
    if (!surface.patchFiles.length) {
      return finding(
        {
          rule: 'unverifiablePatch',
          reason: 'the patch arrives on stdin, so its author cannot be read',
          hint: 'Pass the patch as a file — `git am <file>` — so its author can be checked.',
          evidence: `git ${surface.kind} (no patch file)`,
        },
        `git ${surface.kind}`
      );
    }
    for (const file of surface.patchFiles) {
      const hit = checkPatchFile(surface, file, io);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * A command that switches the repository's hooks off.
 *
 * Only an offence when there is something to switch off: the question is
 * whether ghostwriter's own commit-msg hook — the layer that sees a message
 * after shell expansion — is installed in the repository being targeted. It is
 * asked only when a bypass flag is present, so the ordinary commit pays
 * nothing for this pass.
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

module.exports = {
  checkMessageArgs,
  checkMessageFiles,
  checkIdentityLiterals,
  checkRawCommand,
  checkCopiedCommits,
  checkPatchFiles,
  checkHookBypass,
  checkEffectiveIdentity,
  surfaceCwd,
  surfaceGitDir,
};

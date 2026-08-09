'use strict';

/**
 * imported-authorship.js — the passes for a byline the command does not write,
 * but IMPORTS from something that already carries one.
 *
 * Two commands do it, and neither shows the offending text anywhere in its
 * arguments:
 *
 *   git cherry-pick <ref> / git commit -C <ref>
 *     copies an existing commit's author AND its message onto a new commit.
 *   git am <patch>
 *     takes both from the mail headers inside the file.
 *
 * Every other pass clears these. The message passes find no `-m` text because
 * there is none; the identity passes find a configured user who really is a
 * clean human. The byline that lands is somebody else's, and it arrives from a
 * place only a read can reach.
 */

const { checkText } = require('./attribution');
const { checkIdentity, checkExpectedIdentity } = require('./identity-rules');
const { finding, normalizeRead, readFailure } = require('./finding');
const { surfaceCwd, surfaceGitDir } = require('./surface-target');
const { parsePatches } = require('./patch');

/**
 * An author and a message that arrive together, judged together.
 *
 * `expectHuman` is the one axis on which the two sources differ. A cherry-pick
 * lands a commit in your own history, so an expected-human policy applies to
 * it. A mailed patch is somebody else's work by definition — preserving a
 * contributor's authorship is the entire purpose of `git am`, and demanding
 * that it match the operator would block the command's normal use. What must
 * never ride in either way is a TOOL byline, which is checked for both.
 */
function checkAuthored(source, io, where, expectHuman) {
  const author = checkIdentity(source);
  if (!author.ok) return finding(author, where.author);
  if (expectHuman) {
    const expected = checkExpectedIdentity(source, io.expected);
    if (!expected.ok) return finding(expected, where.author);
  }
  const message = checkText(source.message);
  return message.ok ? null : finding(message, where.message);
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
  const source = io.resolveCommitInfo(surfaceCwd(surface, io), surfaceGitDir(surface, io), ref);
  return checkAuthored(
    source,
    io,
    { author: `the author copied from ${ref}`, message: `the message copied from ${ref}` },
    true
  );
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
 * `git am` reading its patch from stdin — `cat bot.patch | git am`, `git am -`,
 * `git am <(gen)`.
 *
 * The guard cannot read that: the bytes are in a pipe it does not own, and
 * consuming them would take them away from git. So the command is refused,
 * like everything else this plugin cannot see.
 *
 * This is stricter than the equivalent `git commit -F -`, deliberately. A
 * commit has a backstop — git runs `commit-msg` on the final message, after
 * every expansion — and `git am` does not: it runs `applypatch-msg` and
 * friends instead, so nothing downstream would ever see this patch. Refusing
 * here is the only place the byline can be caught.
 */
function checkStdinPatch(surfaces) {
  if (!surfaces.some((surface) => surface.patchStdin)) return null;
  return finding(
    {
      rule: 'unverifiablePatch',
      reason: 'the patch arrives on stdin, so its author and message cannot be read',
      hint: 'Write the patch to a file and pass it to git am, so it can be checked.',
      evidence: 'git am with no patch file named',
    },
    'git am'
  );
}

/** One mail file, which may hold several patches — `git am` applies them all. */
function checkPatchFile(surface, file, io) {
  const read = normalizeRead(io.readMessageFile(file, surfaceCwd(surface, io)));
  const failed = readFailure(read, `the patch ${file}`);
  if (failed) return failed;
  const where = { author: `the author in ${file}`, message: `the message in ${file}` };
  for (const mail of parsePatches(read.text)) {
    const hit = checkAuthored(mail, io, where, false);
    if (hit) return hit;
  }
  return null;
}

function checkPatchFiles(surfaces, io) {
  for (const surface of surfaces) {
    for (const file of surface.patchFiles || []) {
      const hit = checkPatchFile(surface, file, io);
      if (hit) return hit;
    }
  }
  return null;
}

module.exports = { checkCopiedCommits, checkStdinPatch, checkPatchFiles };

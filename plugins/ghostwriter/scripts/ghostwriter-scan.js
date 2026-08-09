#!/usr/bin/env node
'use strict';

/**
 * ghostwriter-scan — check what a CHANGE adds to the files, outside the hook.
 *
 * The PreToolUse guard sees writes an agent makes through its tools, and that
 * is the only path it can see. A change reaching a pull request has usually
 * been through others as well: a script, an editor, a second agent, a merge.
 * This is the layer that does not care how the lines got there.
 *
 * Three places to run it, answering different questions:
 *
 *   pre-commit   --staged         what this commit would add    (before it lands)
 *   CI           --diff <base>    what this branch adds to base (before it merges)
 *   CI           --commits <base> who signed each commit, and what each says
 *
 * `--commits` is the only pass that reads HISTORY rather than a working tree.
 * It is what catches a branch that was pushed from somewhere the guard never
 * ran: a rebase on a laptop, a second agent, a `--no-verify` on a machine
 * without the hooks. Every commit the branch adds is asked the same two
 * questions a live commit is asked — who it says wrote it, and what it says.
 *
 * Additions only. A change that DELETES an attribution shows the offending
 * line with a `-`, and refusing that would block the cleanup this plugin
 * exists to encourage.
 *
 * Usage:
 *   ghostwriter-scan.js --staged [--repo <dir>]        staged changes
 *   ghostwriter-scan.js --diff <base> [--repo <dir>]    this branch against <base>
 *   ghostwriter-scan.js --commits <base> [--repo <dir>] the commits it adds
 *   ghostwriter-scan.js --files <path...>               whole files, as they are
 *
 * `--ignore-from <dir>` reads `.ghostwriterignore` from another tree while
 * still judging this one. CI points it at the base revision, so a change
 * cannot add an attribution-bearing file and the line exempting it in the same
 * breath. Every exemption applied is printed either way: an exemption nobody
 * sees is indistinguishable from a rule that does not work.
 *
 * Exit codes: 0 clean, 1 attribution found, 2 usage error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { inspectFileWrites, unifiedAdditions } = require(path.join(LIB, 'file-content'));
const { checkText } = require(path.join(LIB, 'attribution'));
const { checkIdentity, checkIdentityComplete } = require(path.join(LIB, 'identity-rules'));
const { finding } = require(path.join(LIB, 'finding'));
const { isOverridden } = require(path.join(LIB, 'policy'));
const { renderBlock } = require(path.join(LIB, 'report'));

const EXIT_OK = 0;
const EXIT_FOUND = 1;
const EXIT_USAGE = 2;

const GIT_TIMEOUT_MS = 30000;
/** A diff can be enormous; the guard would rather read it all than sample it. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

const USAGE = [
  'Usage:',
  '  ghostwriter-scan.js --staged [--repo <dir>]         staged changes',
  '  ghostwriter-scan.js --diff <base> [--repo <dir>]     this branch against <base>',
  '  ghostwriter-scan.js --commits <base> [--repo <dir>]  the commits it adds',
  '  ghostwriter-scan.js --files <path...>                whole files, as they are',
  '',
  'Options:',
  '  --repo <dir>          the repository to inspect (default: cwd)',
  '  --ignore-from <dir>   read .ghostwriterignore from there, not from --repo',
].join('\n');

/** What each flag does, and what it needs after it. */
const READERS = {
  '--staged': (args) => {
    args.mode = 'staged';
  },
  '--diff': (args, value) => {
    args.mode = 'diff';
    args.base = value;
  },
  '--commits': (args, value) => {
    args.mode = 'commits';
    args.base = value;
  },
  '--repo': (args, value) => {
    args.repo = value;
  },
  // CI reads exemptions from the base revision, so a change cannot add an
  // attribution-bearing file and the line exempting it in one breath.
  '--ignore-from': (args, value) => {
    args.ignoreFrom = value;
  },
};
const NEEDS = {
  '--diff': 'a base revision',
  '--commits': 'a base revision',
  '--repo': 'a directory',
  '--ignore-from': 'a directory',
};

function validate(args) {
  if (!args.mode) return { error: 'no mode given' };
  if (args.mode === 'files' && !args.files.length) return { error: '--files needs a path' };
  return args;
}

function parseArgs(argv) {
  const args = { mode: null, base: null, repo: process.cwd(), files: [], ignoreFrom: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // Everything after `--files` is a path, including one that looks like a
    // flag: a file may legitimately be called `--weird`.
    if (token === '--files') {
      args.mode = 'files';
      args.files = argv.slice(i + 1);
      break;
    }
    const read = READERS[token];
    if (!read) return { error: `unknown option ${token}` };
    if (NEEDS[token] && argv[i + 1] === undefined)
      return { error: `${token} needs ${NEEDS[token]}` };
    read(args, NEEDS[token] ? argv[++i] : undefined);
  }
  return validate(args);
}

/** Run git in the target repository and hand back its stdout. */
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

/**
 * The diff for a mode.
 *
 * `-U0` because only added lines are read: context costs bytes and buys
 * nothing. `--no-color` and `--no-ext-diff` because a configured pager or an
 * external differ would hand back something this parser cannot read — and a
 * diff it cannot read is a diff it would report as clean.
 */
function readDiff(args) {
  const range = args.mode === 'staged' ? ['--cached'] : [`${args.base}...HEAD`];
  return git(args.repo, ['diff', ...range, '-U0', '--no-color', '--no-ext-diff']);
}

/** Whole files, read as they stand — for a one-off audit of the tree. */
function readFiles(args) {
  return args.files.map((file) => ({
    path: file,
    text: fs.readFileSync(path.resolve(args.repo, file), 'utf8'),
  }));
}

/**
 * Every commit `base..HEAD` adds, with the author it carries.
 *
 * NUL-separated because a commit message contains anything at all — newlines,
 * quotes, its own separators — and any printable delimiter is one an author
 * can write. `%B` is the raw body, so it comes last in each record.
 */
const COMMIT_FORMAT = '%H%x00%an%x00%ae%x00%B%x00%x00%x00';
const COMMIT_RECORD_SEPARATOR = '\u0000\u0000\u0000\n';

function readCommits(args) {
  return git(args.repo, ['log', `--format=${COMMIT_FORMAT}`, `${args.base}..HEAD`])
    .split(COMMIT_RECORD_SEPARATOR)
    .filter(Boolean)
    .map((record) => {
      const [sha, name, email, message] = record.split('\u0000');
      return { sha: (sha || '').slice(0, 8), name, email, message: message || '' };
    });
}

/**
 * One commit already in history: who it says wrote it, and what it says.
 *
 * `resolved: true` because this identity is not a config the guard had to go
 * looking for — it is stamped on the commit. An empty half there is a commit
 * that landed with no author, which is exactly what this pass is looking for.
 */
function checkCommit(commit) {
  const where = `commit ${commit.sha}`;
  const identity = { name: commit.name, email: commit.email, resolved: true };
  const author = [checkIdentity(identity), checkIdentityComplete(identity)].find((r) => !r.ok);
  if (author) return finding(author, `the author of ${where}`);
  const message = checkText(commit.message);
  return message.ok ? null : finding(message, `the message of ${where}`);
}

function inspectCommits(args) {
  for (const commit of readCommits(args)) {
    const hit = checkCommit(commit);
    if (hit) return hit;
  }
  return { blocked: false };
}

/**
 * Name every path an exemption let through.
 *
 * The scanner reads `.ghostwriterignore` from the tree it is checking, so a
 * change can exempt its own file — deliberately, because an exemption belongs
 * in the diff beside the thing it covers, where it is reviewed. That argument
 * only holds if the exemption is visible in the CHECK as well as the diff, so
 * every skip is printed. A silent skip and a passing rule look identical.
 */
function reportExempt(filePath) {
  process.stderr.write(`ghostwriter-scan: exempt by .ghostwriterignore — ${filePath}\n`);
}

function collect(args) {
  if (args.mode === 'files') return readFiles(args);
  return unifiedAdditions(readDiff(args));
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`ghostwriter-scan: ${args.error}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (isOverridden(process.env)) return EXIT_OK;

  let verdict;
  try {
    verdict =
      args.mode === 'commits'
        ? inspectCommits(args)
        : inspectFileWrites(collect(args), {
            cwd: args.repo,
            ignoreFrom: args.ignoreFrom,
            onExempt: reportExempt,
          });
  } catch (err) {
    process.stderr.write(`ghostwriter-scan: cannot read the change (${err.message})\n`);
    return EXIT_USAGE;
  }

  if (!verdict.blocked) return EXIT_OK;
  process.stderr.write(renderBlock(verdict, 'this change'));
  return EXIT_FOUND;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs };

#!/usr/bin/env node
'use strict';

/**
 * ghostwriter-check — validate text (or a repo's git identity) for AI
 * self-attribution, outside the hook.
 *
 * The argument contract is git's: a bare positional path is the commit-message
 * file, which is exactly what git hands a `commit-msg` hook. That makes the
 * installed git hook a one-liner and keeps this CLI usable by hand.
 *
 * Usage:
 *   ghostwriter-check.js <message-file>       validate a commit message file
 *   ghostwriter-check.js --message "<text>"   validate literal text
 *   ghostwriter-check.js -                    validate a message on stdin
 *   ghostwriter-check.js --identity [dir]     validate the git identity in dir
 *
 * Exit codes: 0 clean, 1 attribution found, 2 usage error.
 */

const fs = require('node:fs');
const path = require('node:path');

const { checkText } = require(path.join(__dirname, '..', 'lib', 'attribution'));
const { checkIdentity } = require(path.join(__dirname, '..', 'lib', 'identity-rules'));
const { resolveGitUser } = require(path.join(__dirname, '..', 'lib', 'git-identity'));
const { OVERRIDE_ENV } = require(path.join(__dirname, '..', 'lib', 'guard'));

const EXIT_OK = 0;
const EXIT_FOUND = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'Usage:',
  '  ghostwriter-check.js <message-file>       validate a commit message file',
  '  ghostwriter-check.js --message "<text>"   validate literal text',
  '  ghostwriter-check.js -                    validate a message on stdin',
  '  ghostwriter-check.js --identity [dir]     validate the git identity in dir',
].join('\n');

function parseArgs(argv) {
  if (!argv.length) return { error: 'no input given' };
  const [first, second] = argv;
  if (first === '--identity') return { mode: 'identity', value: second || process.cwd() };
  if (first === '--message') {
    if (second === undefined) return { error: '--message needs a value' };
    return { mode: 'text', value: second };
  }
  if (first === '-') return { mode: 'stdin' };
  if (first.startsWith('-')) return { error: `unknown option ${first}` };
  return { mode: 'file', value: first };
}

function readInput(args) {
  if (args.mode === 'text') return args.value;
  if (args.mode === 'stdin') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(path.resolve(args.value), 'utf8');
}

/** Strip the comment lines git appends to a commit template. */
function stripGitComments(message) {
  return message
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
}

function report(result, subject) {
  process.stderr.write(
    [
      `ghostwriter: ${subject} signs the work as an AI.`,
      '',
      `  rule      ${result.rule}`,
      `  problem   ${result.reason}`,
      `  evidence  ${result.evidence}`,
      '',
      `↳ Fix: ${result.hint}`,
      '',
    ].join('\n')
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`ghostwriter-check: ${args.error}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (process.env[OVERRIDE_ENV] === '1') return EXIT_OK;

  if (args.mode === 'identity') {
    const result = checkIdentity(resolveGitUser(args.value));
    if (result.ok) return EXIT_OK;
    report(result, 'the configured git identity');
    return EXIT_FOUND;
  }

  let text;
  try {
    text = readInput(args);
  } catch (err) {
    process.stderr.write(`ghostwriter-check: cannot read input (${err.message})\n`);
    return EXIT_USAGE;
  }
  const result = checkText(stripGitComments(text));
  if (result.ok) return EXIT_OK;
  report(result, 'this message');
  return EXIT_FOUND;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, stripGitComments };

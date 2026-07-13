#!/usr/bin/env node
/**
 * apply-brief-gate-answers.js (GH-543)
 *
 * File/stdin transport for brief_gate answer persistence. Replaces both
 * argv-JSON transports (`'<JSON_MAP>'` argv and `"$RESOLUTIONS_JSON"`
 * interpolation), which broke — or worse, executed — on a single quote in a
 * user answer. Answer content never touches a shell command line.
 *
 * CLI contract:
 *   node apply-brief-gate-answers.js <briefPath> [--file <answersPath>|--stdin]
 *
 *   - Default answers path: <dirname(briefPath)>/.brief-gate-answers.json
 *   - Envelope shape: { openQuestions: {questionText: answer, ...},
 *                       siblingGaps: [{surface, decision}, ...],
 *                       discrepancies: [{claim, decision}, ...] }
 *     (a flat questionText→answer map is accepted for back-compat)
 *   - Prints a JSON summary to stdout.
 *   - Deletes the answers file ONLY when every entry was applied or already
 *     recorded; a partial apply keeps the file and lists the skipped keys.
 *   - Exit 0 on full apply, 1 otherwise (partial, refused, malformed JSON —
 *     malformed input leaves brief.md and the answers file untouched).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  applyGateResolutions,
  isFullyApplied,
  DEFAULT_ANSWERS_BASENAME,
} = require('../lib/apply-gate-resolutions');

const USAGE = 'Usage: node apply-brief-gate-answers.js <briefPath> [--file <answersPath>|--stdin]';

function parseArgs(argv) {
  const positional = [];
  let file = null;
  let stdin = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stdin') {
      stdin = true;
    } else if (arg === '--file') {
      file = argv[i + 1];
      i++;
      if (!file) return { error: '--file requires a path' };
    } else {
      positional.push(arg);
    }
  }
  if (stdin && file) return { error: '--file and --stdin are mutually exclusive' };
  if (positional.length !== 1) return { error: 'exactly one <briefPath> argument is required' };
  return { briefPath: positional[0], file, stdin };
}

/** Answers-file path for the file transport, or null for --stdin. */
function resolveAnswersPath(args) {
  if (args.stdin) return null;
  return args.file || path.join(path.dirname(args.briefPath), DEFAULT_ANSWERS_BASENAME);
}

/** fd 0 = stdin; both transports keep answers off the command line. */
function readAnswersRaw(answersPath) {
  return answersPath === null ? fs.readFileSync(0, 'utf8') : fs.readFileSync(answersPath, 'utf8');
}

/**
 * Delete the consume-once answers file after a full apply. A failed unlink is
 * non-fatal: a leftover copy of fully-applied answers is harmless because
 * re-apply is idempotent.
 */
function consumeAnswersFile(answersPath) {
  if (!answersPath) return false;
  try {
    fs.unlinkSync(answersPath);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`${args.error}\n${USAGE}\n`);
    return 1;
  }

  const { briefPath } = args;
  const answersPath = resolveAnswersPath(args);
  const answersSource = answersPath === null ? 'stdin' : answersPath;

  let raw;
  try {
    raw = readAnswersRaw(answersPath);
  } catch (e) {
    process.stderr.write(`apply-brief-gate-answers: cannot read ${answersSource}: ${e.message}\n`);
    return 1;
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (e) {
    // Malformed JSON: brief.md untouched, file (if any) kept for inspection.
    process.stderr.write(
      `apply-brief-gate-answers: invalid JSON in ${answersSource}: ${e.message}\n`
    );
    return 1;
  }

  const result = applyGateResolutions(briefPath, envelope);
  const fullyApplied = isFullyApplied(result);
  const deletedAnswersFile = fullyApplied ? consumeAnswersFile(answersPath) : false;

  process.stdout.write(
    `${JSON.stringify({ briefPath, answersSource, ...result, deletedAnswersFile }, null, 2)}\n`
  );
  if (result.refused && result.message) {
    process.stderr.write(`${result.message}\n`);
  }
  return fullyApplied ? 0 : 1;
}

process.exit(main());

/**
 * note-cli.js — the shell shared by `document-note.js` and `memory-note.js`.
 *
 * Both are the sole writer for a gate that refuses agent self-attestation, so
 * both have the same shape: `<command> <TICKET> [--flags]`, a context loaded
 * from the ticket, and a verdict reported to stdout or stderr. Writing that
 * twice put three duplicate blocks in front of the quality gate, which is the
 * right complaint — the second copy is where the two drift apart.
 */

'use strict';

/** `--flag value` / `--flag` (boolean) → `{flag: value | true}`. */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (m) {
      flags[m[1]] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
    }
  }
  return flags;
}

/** A `die` bound to one script's name, for prefixed fatal errors. */
function makeDie(script) {
  return function die(message) {
    process.stderr.write(`${script}: ${message}\n`);
    process.exit(1);
  };
}

/**
 * Print a store's verdict and return the exit code for it.
 *
 * @param {{ok: boolean, reason: string, valid: object[]}} verdict
 * @param {{label: string, noun: string}} opts label names what was checked;
 *   noun names what was counted ('note(s)', 'record(s)').
 */
function reportVerdict(verdict, { label, noun }) {
  if (!verdict.ok) {
    process.stderr.write(`${label} NOT satisfied: ${verdict.reason}\n`);
    return 1;
  }
  process.stdout.write(`${label} satisfied: ${verdict.valid.length} valid ${noun}.\n`);
  return 0;
}

/**
 * Parse `argv`, dispatch to a handler, and exit with its code.
 *
 * Exit 2 is reserved for usage errors (no command, no ticket, unknown
 * command); a handler's own 1 means "ran, and the answer is no".
 *
 * @param {{script: string, usage: string, argv: string[],
 *          loadContext: Function, handlers: Object<string, Function>}} opts
 */
function runNoteCli({ script, usage, argv, loadContext, handlers }) {
  const [command, ticket, ...rest] = argv.slice(2);
  if (!command || !ticket || ticket.startsWith('-')) {
    process.stderr.write(`usage: ${script} ${usage}\n`);
    process.exit(2);
  }
  const handler = handlers[command];
  if (!handler) {
    process.stderr.write(`${script}: unknown command "${command}"\n`);
    process.exit(2);
  }
  process.exit(handler(loadContext(ticket), parseFlags(rest)));
}

module.exports = { parseFlags, makeDie, reportVerdict, runNoteCli };

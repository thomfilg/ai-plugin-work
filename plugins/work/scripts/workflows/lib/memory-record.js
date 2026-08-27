/**
 * memory-record.js — what a `memorize` phase actually recorded, and where.
 *
 * Every sub-workflow ends with a `memorize` phase, and all twelve gated the
 * same way: `touch .<thing>-memorized`, or append `<!-- <thing>-memorized -->`
 * to a file, or set `"memorized": true` in a JSON blob. Each phase's own
 * header said why — "we can't introspect plugin tools to verify remember calls
 * actually happened" — and that much is true. What does not follow is that a
 * bare token is the best available check. A token proves a `touch` ran. It is
 * satisfiable without going anywhere near the memory plugin, which makes it a
 * check that passes without the thing it is checking for.
 *
 * The honest ceiling is one step lower than proof and much higher than a
 * token: require the record to CARRY the substance. An agent cannot mint an
 * 80-substantive-character summary of what it stored without composing it, and
 * what it composed stays on disk to be read afterwards. So:
 *
 *   memory sink → the plugin + tool that took it, plus the summary sent
 *   docs sink   → a path inside the ticket worktree that must still exist and
 *                 still hold substance when the gate reads it
 *
 * That is deliberately the same contract, and the same primitives, as the
 * `document` step's `notes-store.js`; this module adds only the per-phase
 * SCOPE, so a `spec` memorize record cannot discharge `cleanup`'s gate.
 *
 * Records are separate from document notes (`.memory-records.json` vs
 * `.document-notes.json`) because they answer different questions and are
 * staled independently — the document step's receipt is invalidated by HEAD
 * drift, a phase's memorize record by re-entering that phase.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  MIN_SUMMARY_CHARS,
  MIN_DOC_CHARS,
  SINKS,
  allowedRoots,
  docFileHolds,
  summaryIsSubstantial,
} = require(path.join(__dirname, '..', 'work-document', 'lib', 'notes-store'));

const RECORDS_FILE = '.memory-records.json';

function recordsPath(tasksDir) {
  return path.join(tasksDir, RECORDS_FILE);
}

/** Parsed records for the ticket; [] when absent or unreadable (fail-closed). */
function readRecords(tasksDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordsPath(tasksDir), 'utf8'));
    return Array.isArray(parsed?.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

function writeRecords(tasksDir, ticket, records) {
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(recordsPath(tasksDir), `${JSON.stringify({ ticket, records }, null, 2)}\n`);
}

/** Append `record` to the ticket's receipt and return every record now stored. */
function appendRecord(tasksDir, ticket, record) {
  const records = readRecords(tasksDir);
  records.push({ ...record, at: record.at || new Date().toISOString() });
  writeRecords(tasksDir, ticket, records);
  return records;
}

/** Drop every record for `scope` — used when a phase is re-entered. */
function clearScope(tasksDir, ticket, scope) {
  const kept = readRecords(tasksDir).filter((r) => r && r.scope !== scope);
  writeRecords(tasksDir, ticket, kept);
  return kept;
}

/** Is this one record valid on its own terms, for `scope`? */
function recordIsValid(record, scope, roots) {
  if (!record || record.scope !== scope) return false;
  if (!summaryIsSubstantial(record.summary)) return false;
  if (record.sink === SINKS.memory) return Boolean(record.memory && record.tool);
  if (record.sink === SINKS.docs) return docFileHolds(record.path, roots);
  return false;
}

/**
 * The phase's verdict for one scope.
 *
 * `memoryConfigured` decides which sink SATISFIES it, not merely which is
 * preferred — the same rule the document step uses. Without a memory plugin
 * the phases used to auto-pass outright; they now require the record to land
 * in the ticket's worktree docs instead, because "there is nowhere to save it"
 * was never true.
 *
 * @param {{records: object[], scope: string, memoryConfigured: boolean,
 *          worktreeRoot: ?string, tasksDir: ?string}} input
 * @returns {{ok: boolean, reason: string, valid: object[]}}
 */
function evaluateScope({ records, scope, memoryConfigured, worktreeRoot, tasksDir }) {
  const roots = allowedRoots({ worktreeRoot, tasksDir });
  const valid = (records || []).filter((r) => recordIsValid(r, scope, roots));
  if (valid.length === 0) {
    return { ok: false, reason: reasonForNoValidRecord(records, scope, memoryConfigured), valid };
  }
  const required = memoryConfigured ? SINKS.memory : SINKS.docs;
  if (!valid.some((r) => r.sink === required)) {
    return {
      ok: false,
      reason: memoryConfigured
        ? 'a memory plugin is configured, so the record must be saved THROUGH it ' +
          '(what is recorded for this phase only reached worktree docs)'
        : 'no memory plugin is configured, so the record must be written to the ticket ' +
          'worktree docs (what is recorded claims a memory sink that does not exist here)',
      valid,
    };
  }
  return { ok: true, reason: '', valid };
}

function reasonForNoValidRecord(records, scope, memoryConfigured) {
  const where = memoryConfigured
    ? 'the configured memory plugin'
    : 'a docs file in the ticket worktree';
  const mine = (records || []).filter((r) => r && r.scope === scope);
  if (mine.length === 0) {
    return `nothing recorded for \`${scope}\` — save what this phase learned to ${where}`;
  }
  return (
    `${mine.length} record(s) for \`${scope}\` but none valid — a record needs a summary of at ` +
    `least ${MIN_SUMMARY_CHARS} substantive characters, and a docs record needs its file to ` +
    `still exist under the ticket worktree (or its tasks dir) with at least ${MIN_DOC_CHARS} ` +
    `characters`
  );
}

/** The worktree root for `ctx`, resolved lazily and tolerant of failure. */
function worktreeFor(ctx) {
  if (ctx.worktreeRoot !== undefined) return ctx.worktreeRoot;
  try {
    const { resolveTicketWorktree } = require(path.join(__dirname, 'resolve-ticket-worktree'));
    return resolveTicketWorktree(ctx.ticket) || null;
  } catch {
    return null;
  }
}

/**
 * The shared `memorize` gate every sub-workflow phase delegates to.
 *
 * `wait: true` preserves work-brief's distinction between WAITING and BLOCKED
 * — `ok: false` with an EMPTY `errors` array means "no advance yet", which its
 * runner renders differently from a refusal. The distinction is worth keeping:
 * a phase whose agent simply has not got there yet is not a failure.
 *
 * @param {{scope: string, ctx: object, wait?: boolean}} input
 * @returns {{ok: boolean, errors?: string[], summary?: string}}
 */
function validateMemorizePhase({ scope, ctx, wait = false }) {
  const verdict = evaluateScope({
    records: readRecords(ctx.tasksDir),
    scope,
    memoryConfigured: Boolean(ctx.memory),
    worktreeRoot: worktreeFor(ctx),
    tasksDir: ctx.tasksDir,
  });
  if (verdict.ok) {
    const via = ctx.memory ? `via=${ctx.memory.name}` : 'via=worktree docs';
    return { ok: true, summary: `${scope} memorized (${via})` };
  }
  if (wait) return { ok: false, errors: [] };
  return {
    ok: false,
    errors: [`${verdict.reason}. Record it with:\n  ${recordCommand(scope, ctx)}`],
  };
}

/** The one command that satisfies this phase, spelled out for the agent. */
function recordCommand(scope, ctx) {
  const cli = path.join(__dirname, 'scripts', 'memory-note.js');
  const sinkFlag = ctx.memory ? `--tool ${ctx.memory.rememberTool}` : '--path <docs file>';
  return `node ${cli} record ${ctx.ticket} --scope ${scope} ${sinkFlag} --summary "..."`;
}

/**
 * The instruction block every `memorize` phase prints.
 *
 * Phases used to end with "then `touch <sentinel>`", and — when no memory
 * plugin was installed — with "auto-advance". Both are now false: the phase is
 * satisfied by a recorded summary, and the absence of a memory plugin moves
 * the record to worktree docs rather than removing it.
 *
 * @param {{title: string, scope: string, ctx: object, what: string[]}} input
 */
function memorizeInstructions({ title, scope, ctx, what }) {
  const sink = ctx.memory
    ? `Call \`${ctx.memory.rememberTool}\` (memory plugin: **${ctx.memory.name}**) with:`
    : 'No memory plugin is configured here, so this goes to the ticket worktree docs. Write:';
  return [
    title,
    `Ticket: ${ctx.ticket}`,
    '',
    '### What to save',
    sink,
    ...what.map((line) => `- ${line}`),
    '',
    '### Then record it',
    'The phase is satisfied by the record, not by a marker file — the summary has',
    `to say what you saved (at least ${MIN_SUMMARY_CHARS} substantive characters).`,
    '',
    '```bash',
    recordCommand(scope, ctx),
    '```',
    '',
    'Re-run me to verify.',
    '',
  ].join('\n');
}

module.exports = {
  RECORDS_FILE,
  memorizeInstructions,
  validateMemorizePhase,
  recordCommand,
  MIN_SUMMARY_CHARS,
  MIN_DOC_CHARS,
  SINKS,
  recordsPath,
  readRecords,
  appendRecord,
  clearScope,
  evaluateScope,
  recordIsValid,
};

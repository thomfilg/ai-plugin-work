#!/usr/bin/env node

/**
 * memory-note.js — the only writer for every sub-workflow's `memorize` phase.
 *
 * The phases used to gate on a token the agent minted itself: `touch
 * .spec-memorized`, an appended `<!-- tasks-memorized -->`, a `"memorized":
 * true` key. Each proved a write happened; none proved anything was saved.
 * This CLI replaces all of them, and validates before it stores, so the phase
 * gate reads a record that had to carry content to exist.
 *
 * SCOPE is what keeps the twelve phases distinct: a record saved for `spec`
 * does not discharge `cleanup`'s gate.
 *
 * Usage:
 *   memory-note.js sink   <TICKET> --scope <scope>
 *       Print where this machine expects the record to go: the configured
 *       memory plugin, or the worktree docs path when there is none.
 *
 *   memory-note.js record <TICKET> --scope <scope> --summary "<what you saved>"
 *                         [--tool <rememberTool> | --path <docs file>]
 *       Append one record. The sink is inferred: a configured memory plugin
 *       means --tool, no memory plugin means --path.
 *
 *   memory-note.js verify <TICKET> --scope <scope>
 *       Exit 0 when the phase's evidence holds, 1 with the reason when not.
 *       The same evaluation the phase's validate() runs.
 */

'use strict';

const path = require('node:path');

const { requireTasksBase } = require(path.join(__dirname, '..', 'ticket-validation'));
const { detectMemoryPlugin } = require(path.join(__dirname, '..', 'detect-memory-plugin'));
const { resolveTicketWorktree } = require(path.join(__dirname, '..', 'resolve-ticket-worktree'));
const { summaryIsSubstantial } = require(
  path.join(__dirname, '..', '..', 'work-document', 'lib', 'notes-store')
);
const { appendRecord, readRecords, evaluateScope, SINKS, MIN_SUMMARY_CHARS } = require(
  path.join(__dirname, '..', 'memory-record')
);
const { makeDie, reportVerdict, runNoteCli } = require(path.join(__dirname, '..', 'note-cli'));

const SCRIPT = 'memory-note.js';
const die = makeDie(SCRIPT);

/**
 * `docs/work-notes/<TICKET>-<scope>.md` inside the ticket's worktree — or,
 * when that cannot be resolved, `<scope>-memory.md` in the ticket's tasks dir.
 * Both are places the gate accepts, so this never returns a path it would then
 * reject.
 */
function defaultDocsPath(ticket, scope, worktreeRoot, tasksDir) {
  if (worktreeRoot) return path.join(worktreeRoot, 'docs', 'work-notes', `${ticket}-${scope}.md`);
  return tasksDir ? path.join(tasksDir, `${scope}-memory.md`) : '';
}

function loadContext(ticket) {
  return {
    ticket,
    tasksDir: path.join(requireTasksBase(), ticket),
    memory: detectMemoryPlugin(),
    worktreeRoot: resolveTicketWorktree(ticket) || null,
  };
}

function requireScope(flags) {
  if (typeof flags.scope !== 'string' || !flags.scope.trim()) {
    die('--scope is required (the phase recording this: spec, tasks, cleanup, …)');
  }
  return flags.scope.trim();
}

function cmdSink(ctx, scope) {
  if (ctx.memory) {
    process.stdout.write(
      `memory\t${ctx.memory.name}\t${ctx.memory.rememberTool}\n` +
        `Save it by calling ${ctx.memory.rememberTool}, then record it:\n` +
        `  node ${SCRIPT} record ${ctx.ticket} --scope ${scope} ` +
        `--tool ${ctx.memory.rememberTool} --summary "..."\n`
    );
    return 0;
  }
  const docs = defaultDocsPath(ctx.ticket, scope, ctx.worktreeRoot, ctx.tasksDir);
  process.stdout.write(
    `docs\t${docs || '(worktree unresolved)'}\n` +
      `No memory plugin is configured. Write it to the worktree, then record it:\n` +
      `  node ${SCRIPT} record ${ctx.ticket} --scope ${scope} --path ${docs || '<file>'} ` +
      `--summary "..."\n`
  );
  return 0;
}

/**
 * Build the record for this machine's sink. Refuses a --tool record when no
 * memory plugin is configured and a --path record when one is: the phase's
 * contract is about WHERE the record lives, so letting the agent pick the
 * other sink would make the requirement advisory.
 */
function buildRecord(ctx, scope, flags) {
  const summary = typeof flags.summary === 'string' ? flags.summary : '';
  if (!summaryIsSubstantial(summary)) {
    die(
      `--summary must be at least ${MIN_SUMMARY_CHARS} substantive characters — ` +
        'say what you saved and what a later run should be able to recall'
    );
  }
  if (ctx.memory) {
    if (flags.path) {
      die(
        `memory plugin "${ctx.memory.name}" is configured — save through ` +
          `${ctx.memory.rememberTool} and record with --tool, not --path`
      );
    }
    const tool = typeof flags.tool === 'string' ? flags.tool : ctx.memory.rememberTool;
    return { scope, sink: SINKS.memory, memory: ctx.memory.name, tool, summary };
  }
  if (flags.tool) {
    die(
      'no memory plugin is configured on this machine — write it to the worktree docs ' +
        'and record it with --path'
    );
  }
  const notePath =
    typeof flags.path === 'string'
      ? flags.path
      : defaultDocsPath(ctx.ticket, scope, ctx.worktreeRoot, ctx.tasksDir);
  if (!notePath) die('--path is required (neither the worktree nor the tasks dir resolved)');
  return { scope, sink: SINKS.docs, path: path.resolve(notePath), summary };
}

function verdictFor(ctx, scope, records) {
  return evaluateScope({
    records,
    scope,
    memoryConfigured: Boolean(ctx.memory),
    worktreeRoot: ctx.worktreeRoot,
    tasksDir: ctx.tasksDir,
  });
}

function cmdRecord(ctx, scope, flags) {
  const record = buildRecord(ctx, scope, flags);
  const verdict = verdictFor(ctx, scope, appendRecord(ctx.tasksDir, ctx.ticket, record));
  if (!verdict.ok) {
    process.stderr.write(
      `${SCRIPT}: record stored but \`${scope}\` is NOT satisfied — ${verdict.reason}\n`
    );
    return 1;
  }
  process.stdout.write(
    `Recorded ${record.sink} memory for ${ctx.ticket} \`${scope}\` ` +
      `(${verdict.valid.length} valid record(s)).\n`
  );
  return 0;
}

function cmdVerify(ctx, scope) {
  return reportVerdict(verdictFor(ctx, scope, readRecords(ctx.tasksDir)), {
    label: `memorize \`${scope}\``,
    noun: 'record(s)',
  });
}

if (require.main === module) {
  runNoteCli({
    script: SCRIPT,
    usage: '<sink|record|verify> <TICKET> --scope <scope> [--summary "..."]',
    argv: process.argv,
    loadContext,
    handlers: {
      sink: (ctx, flags) => cmdSink(ctx, requireScope(flags)),
      record: (ctx, flags) => cmdRecord(ctx, requireScope(flags), flags),
      verify: (ctx, flags) => cmdVerify(ctx, requireScope(flags)),
    },
  });
}

module.exports = { defaultDocsPath, buildRecord };

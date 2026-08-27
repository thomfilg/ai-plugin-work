#!/usr/bin/env node

/**
 * document-note.js — the `document` step's only writer.
 *
 * The step asks the agent for one thing: record what this ticket's work
 * actually taught, where the next run will find it. This CLI is how that
 * recording becomes evidence — agents cannot hand-write `.document-notes.json`
 * (protect-artifact-files.js gates it), so every note goes through `record`,
 * which validates before it stores.
 *
 * Usage:
 *   document-note.js sink    <TICKET>
 *       Print where this machine expects the note to go: the configured
 *       memory plugin, or the worktree docs path when there is none.
 *
 *   document-note.js record  <TICKET> --summary "<what you learned>"
 *                            [--tool <rememberTool> | --path <docs file>]
 *       Append one note. The sink is inferred: a configured memory plugin
 *       means --tool, no memory plugin means --path.
 *
 *   document-note.js verify  <TICKET>
 *       Exit 0 when the step's evidence holds, 1 with the reason when not.
 *       The same evaluation the transition gate runs.
 */

'use strict';

const path = require('node:path');

const { requireTasksBase } = require(path.join(__dirname, '..', 'lib', 'ticket-validation'));
const { detectMemoryPlugin } = require(path.join(__dirname, '..', 'lib', 'detect-memory-plugin'));
const { resolveTicketWorktree } = require(
  path.join(__dirname, '..', 'lib', 'resolve-ticket-worktree')
);
const { appendNote, readNotes, evaluateNotes, SINKS, summaryIsSubstantial, MIN_SUMMARY_CHARS } =
  require(path.join(__dirname, 'lib', 'notes-store'));
const { makeDie, reportVerdict, runNoteCli } = require(
  path.join(__dirname, '..', 'lib', 'note-cli')
);

const SCRIPT = 'document-note.js';
const die = makeDie(SCRIPT);

/**
 * `docs/work-notes/<TICKET>.md` inside the ticket's worktree — or, when that
 * cannot be resolved, `work-notes.md` in the ticket's tasks dir. Both are
 * places a later run looks; the gate requires the note to be under one of
 * them, so this never returns a path the gate would then reject.
 */
function defaultDocsPath(ticket, worktreeRoot, tasksDir) {
  if (worktreeRoot) return path.join(worktreeRoot, 'docs', 'work-notes', `${ticket}.md`);
  return tasksDir ? path.join(tasksDir, 'work-notes.md') : '';
}

/** Everything both subcommands need: paths, and which sink this machine wants. */
function loadContext(ticket) {
  const tasksDir = path.join(requireTasksBase(), ticket);
  const memory = detectMemoryPlugin();
  const worktreeRoot = resolveTicketWorktree(ticket) || null;
  return { ticket, tasksDir, memory, worktreeRoot };
}

function cmdSink(ctx) {
  if (ctx.memory) {
    process.stdout.write(
      `memory\t${ctx.memory.name}\t${ctx.memory.rememberTool}\n` +
        `Save the note by calling ${ctx.memory.rememberTool}, then record it:\n` +
        `  node ${SCRIPT} record ${ctx.ticket} --tool ${ctx.memory.rememberTool} --summary "..."\n`
    );
    return 0;
  }
  const docs = defaultDocsPath(ctx.ticket, ctx.worktreeRoot, ctx.tasksDir);
  process.stdout.write(
    `docs\t${docs || '(worktree unresolved)'}\n` +
      `No memory plugin is configured. Write the note to the worktree, then record it:\n` +
      `  node ${SCRIPT} record ${ctx.ticket} --path ${docs || '<file>'} --summary "..."\n`
  );
  return 0;
}

/**
 * Build the note for this machine's sink. Refuses a --tool note when no memory
 * plugin is configured and a --path note when one is: the step's contract is
 * about WHERE the note lives, so letting the agent pick the other sink would
 * make the requirement advisory.
 */
function buildNote(ctx, flags) {
  const summary = typeof flags.summary === 'string' ? flags.summary : '';
  if (!summaryIsSubstantial(summary)) {
    die(
      `--summary must be at least ${MIN_SUMMARY_CHARS} substantive characters — ` +
        'say what the work changed, what surprised you, and what the next run should know'
    );
  }
  if (ctx.memory) {
    const tool = typeof flags.tool === 'string' ? flags.tool : ctx.memory.rememberTool;
    if (flags.path) {
      die(
        `memory plugin "${ctx.memory.name}" is configured — save through ${ctx.memory.rememberTool} ` +
          'and record with --tool, not --path'
      );
    }
    return { sink: SINKS.memory, memory: ctx.memory.name, tool, summary };
  }
  if (flags.tool) {
    die(
      'no memory plugin is configured on this machine — write the note to the worktree docs and record it with --path'
    );
  }
  const notePath =
    typeof flags.path === 'string'
      ? flags.path
      : defaultDocsPath(ctx.ticket, ctx.worktreeRoot, ctx.tasksDir);
  if (!notePath) die('--path is required (neither the worktree nor the tasks dir resolved)');
  return { sink: SINKS.docs, path: path.resolve(notePath), summary };
}

function cmdRecord(ctx, flags) {
  const note = buildNote(ctx, flags);
  const notes = appendNote(ctx.tasksDir, ctx.ticket, note);
  const verdict = evaluateNotes({
    notes,
    memoryConfigured: Boolean(ctx.memory),
    worktreeRoot: ctx.worktreeRoot,
    tasksDir: ctx.tasksDir,
  });
  if (!verdict.ok) {
    process.stderr.write(
      `${SCRIPT}: note stored but the step is NOT satisfied — ${verdict.reason}\n`
    );
    return 1;
  }
  process.stdout.write(
    `Recorded ${note.sink} note for ${ctx.ticket} (${verdict.valid.length} valid note(s)).\n`
  );
  return 0;
}

function cmdVerify(ctx) {
  const verdict = evaluateNotes({
    notes: readNotes(ctx.tasksDir),
    memoryConfigured: Boolean(ctx.memory),
    worktreeRoot: ctx.worktreeRoot,
    tasksDir: ctx.tasksDir,
  });
  return reportVerdict(verdict, { label: 'document step', noun: 'note(s)' });
}

if (require.main === module) {
  runNoteCli({
    script: SCRIPT,
    usage: '<sink|record|verify> <TICKET> [--summary "..."]',
    argv: process.argv,
    loadContext,
    handlers: {
      sink: (ctx) => cmdSink(ctx),
      record: (ctx, flags) => cmdRecord(ctx, flags),
      verify: (ctx) => cmdVerify(ctx),
    },
  });
}

module.exports = { defaultDocsPath, buildNote };

#!/usr/bin/env node
'use strict';

/**
 * ghostwriter — the PreToolUse guard that keeps AI attribution out of the work.
 *
 * Three kinds of call are inspected, because a tool can sign the work in three
 * places: the shell (git authorship and `gh` posts), a forge MCP call (pull
 * request and comment text, and files committed through the API), and a file
 * write (a footer in a source comment, which ships in the diff and outlives
 * both the message and the description). Calls that author nothing fall
 * straight through; the rest are checked for self-attribution — an authorship
 * trailer, a "generated with <tool>" footer, a product link, a tool-named
 * session trailer, or a committer identity that names a tool or nobody at all
 * — and blocked with the offending line quoted back.
 *
 * TWO-TIER FAILURE POLICY. A guard that bricks the shell when it has a bug is
 * worse than the attribution it prevents, so the outer entry protocol is
 * fail-OPEN: an unexpected throw is logged and the command runs. But once the
 * command is known to author a commit, the calculus flips — silently allowing
 * an unchecked commit is the one outcome this plugin exists to prevent — so
 * inspection errors on an authoring command fail CLOSED with the reason on
 * stderr.
 */

const path = require('node:path');

const LIB_DIR = path.join(__dirname, '..', 'lib');
const runtime = require(path.join(LIB_DIR, 'runtime'));
const { logHookError } = require(path.join(LIB_DIR, 'hookEntrypoint'));
const { inspectCommand, inspectToolCall, inspectWrite, renderBlock } = require(
  path.join(LIB_DIR, 'guard')
);
const { hasAuthorshipSurface } = require(path.join(LIB_DIR, 'git-surfaces'));
const { isForgeTool } = require(path.join(LIB_DIR, 'forge-surfaces'));
const { writeFiles } = require(path.join(LIB_DIR, 'file-content'));

/** Is anything actually at stake in this command? Never throws. */
function authorsGitObject(command) {
  try {
    return hasAuthorshipSurface(command);
  } catch {
    return false;
  }
}

function blockOnError(rt, err, subject) {
  rt.emit.block(
    `ghostwriter: could not verify this ${subject} (${err.message}).\n` +
      'Blocking rather than letting unchecked authorship through.\n'
  );
}

/** Bash — git authorship and `gh` posts both ride the shell. */
function handleCommand(rt, evt, command) {
  let verdict;
  try {
    verdict = inspectCommand(command, { cwd: evt.cwd });
  } catch (err) {
    if (!authorsGitObject(command)) return;
    blockOnError(rt, err, 'git authorship command');
    return;
  }
  if (verdict.blocked) rt.emit.block(renderBlock(verdict));
}

/** A forge MCP call — the text arrives as named fields, no parsing needed. */
function handleToolCall(rt, evt) {
  let verdict;
  try {
    verdict = inspectToolCall(evt.rawToolName, evt.toolInput, { cwd: evt.cwd });
  } catch (err) {
    blockOnError(rt, err, 'forge tool call');
    return;
  }
  if (verdict.blocked) rt.emit.block(renderBlock(verdict));
}

/**
 * A file write — the text a change carries, rather than the text about it.
 *
 * Fails CLOSED like the authoring commands: once the call is known to write a
 * file, an inspection that throws is a file whose content nobody checked.
 */
function handleWrite(rt, evt) {
  let verdict;
  try {
    verdict = inspectWrite(writeFiles(evt.rawToolName, evt.toolInput), { cwd: evt.cwd });
  } catch (err) {
    blockOnError(rt, err, 'file write');
    return;
  }
  if (verdict.blocked) rt.emit.block(renderBlock(verdict, 'this file'));
}

function handle({ rt, evt }) {
  const command = evt.shellCommand;
  if (command) {
    handleCommand(rt, evt, command);
    return;
  }
  if (isForgeTool(evt.rawToolName)) {
    handleToolCall(rt, evt);
    return;
  }
  // toolKind is the runtime's own classification, so codex `apply_patch`
  // arrives here as a write without the matcher having to name it (which it
  // must not: naming it churns trust hashes, and Write/Edit already alias).
  if (evt.toolKind === 'write') handleWrite(rt, evt);
}

runtime.runHook(handle, {
  event: 'PreToolUse',
  onError: 'open',
  file: __filename,
  logError: logHookError,
});

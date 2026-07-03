'use strict';

/**
 * Orchestrates the per-tool checks and returns a verdict:
 *   { exitCode: 0 } → allow
 *   { exitCode: 2, message } → block
 *   { exitCode: 0, rewrite } → allow but run the command with the runtime shim
 *     preloaded (GH-657); the hook emits it as updatedInput.command.
 */

const os = require('node:os');
const path = require('node:path');
const { findProtectedPathRefs, findProtectedTarget, resolvePathSafe } = require('./paths');
const { isReadOnlyBashCommand, bashTargets } = require('./bash');
const { isReadOnlyTaskPrompt } = require('./task');
const { findUnlockedPhrases, isEntryUnlocked } = require('./transcript');
const { checkScriptBypass } = require('./scripts-bypass');
const { shimPath, runsExternalScript, buildShimRewrite } = require('./fsguard');

// Frozen: returned by reference from every allow-path and exported, so freezing
// prevents a consumer from silently corrupting all future evaluations.
const ALLOW = Object.freeze({ exitCode: 0, message: '' });

function blockMessage(reason, entry, matchContext) {
  // Only the USER typing the phrase unlocks (see transcript.js): tool output —
  // including this very message echoed back as a tool_result — is never trusted,
  // so an agent cannot self-unlock by emitting the phrase.
  // Surface a cross-project origin: when the blocking lock came from the shared
  // store, the user may not expect it (it is not this project's own config). The
  // literal `(shared)` token is the contract asserted by the cross-project e2e.
  // See GH-585 (AC8 from GH-541).
  const origin = entry && entry.kind === 'shared' ? ' (shared)' : '';
  let msg = `BLOCKED (heimdall)${origin}: ${reason}\n`;
  if (entry) {
    if (origin) {
      msg += `This lock comes from your shared (cross-project) heimdall store, not this project.\n`;
    }
    const phrase = entry.unlockPhrase || `edit ${path.basename(entry.dir)}`;
    msg += `\nACTION REQUIRED: Stop and ask the user to UNLOCK this path. Tell them to reply with the\n`;
    msg += `exact phrase (they must type it themselves — only a user message unlocks it):\n`;
    msg += `  ${phrase}\n`;
    msg += `Then retry. Do NOT try alternative approaches or attempt to emit the phrase yourself.\n`;
  }
  if (matchContext) msg += `MATCH: ${matchContext}\n`;
  return msg;
}

function block(reason, entry, ctx) {
  return { exitCode: 2, message: blockMessage(reason, entry, ctx) };
}

function isInAllowedSubdir(entry, normalizedPath) {
  if (entry.isFile || !entry.allowedPaths) return false;
  const relPath = path.relative(entry.dir, normalizedPath);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) return false;
  return entry.allowedPaths.includes(relPath.split(path.sep)[0]);
}

function evaluateFileTool(toolInput, entries, unlocked) {
  const filePath = toolInput.file_path || toolInput.filePath || '';
  if (!filePath) return ALLOW;
  const normalizedPath = resolvePathSafe(filePath);
  const entry = findProtectedTarget(normalizedPath, entries);
  if (!entry) return ALLOW;
  if (isInAllowedSubdir(entry, normalizedPath)) return ALLOW;
  if (isEntryUnlocked(entry, unlocked)) return ALLOW;
  const shown = normalizedPath.replace(os.homedir(), '~');
  const kind = entry.isFile ? 'a protected file' : 'in a protected directory';
  return block(`${shown} is ${kind}`, entry, 'file-tool ' + path.basename(entry.dir));
}

function evaluateTask(toolInput, entries, unlocked) {
  const combined = JSON.stringify(toolInput).slice(0, 20000);
  const refs = findProtectedPathRefs(combined, entries);
  if (refs.length === 0 || isReadOnlyTaskPrompt(combined)) return ALLOW;
  // Block on the first referenced entry that is still locked — an unlocked
  // entry must not green-light a prompt that also touches other locked ones.
  for (const entry of refs) {
    if (!isEntryUnlocked(entry, unlocked)) {
      return block(
        `Task prompt references protected path (${path.basename(entry.dir)})`,
        entry,
        'task-prompt ' + path.basename(entry.dir)
      );
    }
  }
  return ALLOW;
}

function evaluateBashScripts(command, entries, unlocked) {
  // Runtime shim (GH-657): when the command runs an external script and there
  // are still-locked protected DIRECTORIES, don't guess the write target from
  // the script's text — preload the interposer, which denies writes under the
  // locked dirs at runtime (covering variable/path.join/subprocess targets) and
  // lets everything else through (clearing the read-elsewhere / test-run false
  // positives). Scoped to LOCKED dirs only, so an unlocked entry writes freely.
  const lockedDirs = entries.filter((e) => !e.isFile && !isEntryUnlocked(e, unlocked));
  if (lockedDirs.length && runsExternalScript(command)) {
    const so = shimPath();
    if (so) return { exitCode: 0, rewrite: buildShimRewrite(command, lockedDirs, so) };
    // No shim for this platform → fall through to the static fail-closed check.
  }

  const collapsedCmd = command.replace(/\s*\n+\s*/g, ' ');
  for (const entry of entries) {
    if (entry.isFile) continue;
    const res = checkScriptBypass(collapsedCmd, entry, entries);
    if (!res.blocked) continue;
    if (res.error) return { exitCode: 2, message: `BLOCKED: ${res.error}. Blocking for safety.\n` };
    // Unlocked → skip this entry but keep checking; a later locked entry the
    // same script writes to must still be caught (one unlock must not allow all).
    if (isEntryUnlocked(entry, unlocked)) continue;
    return block(
      `Script "${res.scriptPath}" writes to protected path (${path.basename(entry.dir)})`,
      entry,
      'script-write ' + path.basename(entry.dir)
    );
  }
  return ALLOW;
}

function evaluateBash(toolInput, entries, unlocked) {
  const command = toolInput.command || '';
  if (isReadOnlyBashCommand(command)) return ALLOW;

  // Block on the first targeted entry still locked — a compound command may
  // write to several protected paths; one unlocked entry must not allow the rest.
  for (const { entry, matchType } of bashTargets(command, entries)) {
    if (isEntryUnlocked(entry, unlocked)) continue;
    const ctx =
      (matchType === 'absolute-path' ? 'bash-absolute-path-write ' : 'bash-write ') +
      path.basename(entry.dir);
    return block('Bash command targets protected path', entry, ctx);
  }

  return evaluateBashScripts(command, entries, unlocked);
}

const HANDLERS = {
  Edit: evaluateFileTool,
  Write: evaluateFileTool,
  MultiEdit: evaluateFileTool,
  Task: evaluateTask,
  Bash: evaluateBash,
};

/** Evaluate one tool call against entries. */
function evaluate({ toolName, toolInput, transcriptPath, entries }) {
  if (!entries || entries.length === 0) return ALLOW;
  const handler = HANDLERS[toolName];
  if (!handler) return ALLOW;
  const unlocked = findUnlockedPhrases(transcriptPath, entries);
  return handler(toolInput || {}, entries, unlocked);
}

module.exports = { evaluate, blockMessage, ALLOW };

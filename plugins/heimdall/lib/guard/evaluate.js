'use strict';

/**
 * Orchestrates the per-tool checks and returns a verdict:
 *   { exitCode: 0 } → allow   |   { exitCode: 2, message } → block.
 */

const os = require('node:os');
const path = require('node:path');
const { findProtectedPathRef, findProtectedTarget, resolvePathSafe } = require('./paths');
const { isReadOnlyBashCommand, bashTargetsProtectedTarget } = require('./bash');
const { isReadOnlyTaskPrompt } = require('./task');
const { findUnlockedPhrases, isEntryUnlocked } = require('./transcript');
const { checkScriptBypass } = require('./scripts-bypass');

const ALLOW = { exitCode: 0, message: '' };

function blockMessage(reason, entry, matchContext) {
  // Only the USER typing the phrase unlocks (see transcript.js): tool output —
  // including this very message echoed back as a tool_result — is never trusted,
  // so an agent cannot self-unlock by emitting the phrase.
  let msg = `BLOCKED (heimdall): ${reason}\n`;
  if (entry) {
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
  const entry = findProtectedPathRef(combined, entries);
  if (!entry) return ALLOW;
  if (isEntryUnlocked(entry, unlocked)) return ALLOW;
  if (isReadOnlyTaskPrompt(combined)) return ALLOW;
  return block(
    `Task prompt references protected path (${path.basename(entry.dir)})`,
    entry,
    'task-prompt ' + path.basename(entry.dir)
  );
}

function evaluateBashScripts(command, entries, unlocked) {
  const collapsedCmd = command.replace(/\s*\n+\s*/g, ' ');
  for (const entry of entries) {
    if (entry.isFile) continue;
    const res = checkScriptBypass(collapsedCmd, entry, entries);
    if (!res.blocked) continue;
    if (res.error) return { exitCode: 2, message: `BLOCKED: ${res.error}. Blocking for safety.\n` };
    if (isEntryUnlocked(entry, unlocked)) return ALLOW;
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

  const bashResult = bashTargetsProtectedTarget(command, entries);
  if (bashResult) {
    if (isEntryUnlocked(bashResult.entry, unlocked)) return ALLOW;
    const ctx =
      (bashResult.matchType === 'absolute-path' ? 'bash-absolute-path-write ' : 'bash-write ') +
      path.basename(bashResult.entry.dir);
    return block('Bash command targets protected path', bashResult.entry, ctx);
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

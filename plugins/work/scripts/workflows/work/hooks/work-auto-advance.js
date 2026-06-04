#!/usr/bin/env node

/**
 * work-auto-advance.js — PostToolUse hook for /work.
 *
 * After each Task/Skill completion, this hook:
 * 1. Checks if a /work session is active (marker file exists)
 * 2. Calls work-next.js to get the next instruction
 * 3. Outputs the instruction via console.log() (visible to AI)
 *
 * Fail-open: Any error → exit 0 silently.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

function main() {
  // Read hook input from stdin
  let hookData;
  try {
    const input = fs.readFileSync(0, 'utf8');
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Guard: do NOT fire inside sub-agents (would advance state while agent is working)
  const transcriptPath = hookData?.transcript_path || '';
  if (transcriptPath.includes('/subagents/')) process.exit(0);

  // Guard: find active /work session via marker file
  const { resolvePluginPaths } = require(path.join(__dirname, '..', 'lib', 'resolve-plugin-root'));
  const { libDir } = resolvePluginPaths(__dirname, 3);
  const getConfig = require(path.join(libDir, 'get-config'));
  const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
  const TASKS_BASE =
    getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
  if (!TASKS_BASE) process.exit(0);

  // Find THIS terminal's .work.pid marker. findActiveMarker scopes by owning
  // session id + worktree root, so a hook firing in one agent never advances
  // another agent's workflow (cross-wiring).
  const { findActiveMarker } = require(path.join(__dirname, '..', 'lib', 'marker'));
  const marker = findActiveMarker(TASKS_BASE, '.work.pid');
  if (!marker) process.exit(0);

  // Guard: marker must be recent (less than 12 hours old) to avoid stale sessions
  const markerAge = Date.now() - new Date(marker.startedAt).getTime();
  if (markerAge > 12 * 60 * 60 * 1000) process.exit(0);

  // Call work-next.js
  const workNextPath = path.join(__dirname, '..', 'work-next.js');
  let result;
  try {
    result = execFileSync(process.execPath, [workNextPath, marker.ticket], {
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    process.exit(0);
  }

  // Parse and output instruction
  let instruction;
  try {
    instruction = JSON.parse(result);
  } catch {
    process.exit(0);
  }

  // Output the instruction for the AI to see
  if (instruction.action === 'execute') {
    console.log('');
    console.log('═══ WORK2: NEXT STEP ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('════════════════════════');
    console.log('');
  } else if (instruction.action === 'complete') {
    console.log('');
    console.log('═══ WORK2: COMPLETE ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('═══════════════════════');
    console.log('');
  } else if (instruction.action === 'blocked') {
    console.log('');
    console.log('═══ WORK2: BLOCKED ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('══════════════════════');
    console.log('');
  }

  process.exit(0);
}

/**
 * firePostToolCall — dispatch the OnPostToolCall extension event before the
 * existing auto-advance logic, gated on an active /work marker. Errors are
 * swallowed so a misbehaving extension can never crash the hook.
 *
 * @param {{toolName: string, toolInput: any, toolResult: any, tasksDir: string, repoRoot: string}} args
 * @param {{
 *   findActiveMarker?: Function,
 *   initExtensions?: Function,
 * }} [deps]
 * @returns {void}
 */
function firePostToolCall(args, deps) {
  const { toolName, toolInput, toolResult, tasksDir, repoRoot } = args || {};
  let marker = null;
  try {
    const findMarker =
      deps?.findActiveMarker ||
      require(path.join(__dirname, '..', 'lib', 'marker')).findActiveMarker;
    marker = findMarker(tasksDir, '.work.pid');
  } catch {
    /* fail-open */
  }
  if (!marker) return;
  try {
    const init =
      deps?.initExtensions ||
      require(path.join(__dirname, '..', 'lib', 'extensions')).initExtensions;
    const api = init({ repoRoot, tasksDir });
    api.dispatch('OnPostToolCall', { toolName, toolInput, toolResult });
  } catch {
    /* fail-open — extension dispatch errors must never crash the hook */
  }
}

/**
 * fireAgentResponseMatched — iterate registered `OnAgentResponseMatched`
 * handlers and dispatch only when the response text matches each handler's
 * compiled `match` regex (compiled once at registration in event-bus). Gated
 * on an active /work marker. Errors are swallowed so a misbehaving extension
 * can never crash the hook.
 *
 * Dispatch payload (G9): `{ responseText, match: { pattern, substring } }`.
 *
 * @param {{responseText: string, tasksDir: string, repoRoot: string}} args
 * @param {{
 *   findActiveMarker?: Function,
 *   initExtensions?: Function,
 * }} [deps]
 * @returns {void}
 */
function fireAgentResponseMatched(args, deps) {
  const { responseText, tasksDir, repoRoot } = args || {};
  let marker = null;
  try {
    const findMarker =
      deps?.findActiveMarker ||
      require(path.join(__dirname, '..', 'lib', 'marker')).findActiveMarker;
    marker = findMarker(tasksDir, '.work.pid');
  } catch {
    /* fail-open */
  }
  if (!marker) return;
  try {
    const init =
      deps?.initExtensions ||
      require(path.join(__dirname, '..', 'lib', 'extensions')).initExtensions;
    const api = init({ repoRoot, tasksDir });
    const handlers =
      typeof api.listHandlers === 'function' ? api.listHandlers('OnAgentResponseMatched') : [];
    for (const record of handlers) {
      if (!record || !record.match || !record.match.compiled) continue;
      const m = record.match.compiled.exec(responseText || '');
      if (!m) continue;
      try {
        api.dispatch('OnAgentResponseMatched', {
          responseText,
          match: { pattern: record.match.pattern, substring: m[0] },
        });
      } catch {
        /* fail-open — extension dispatch errors must never crash the hook */
      }
    }
  } catch {
    /* fail-open */
  }
}

module.exports = { firePostToolCall, fireAgentResponseMatched };

if (!process.env.WORK_HOOK_NO_MAIN) {
  main();
}

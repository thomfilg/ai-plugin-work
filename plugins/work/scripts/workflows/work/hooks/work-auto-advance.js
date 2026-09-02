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

const path = require('path');
const { execFileSync } = require('child_process');
const { installFailOpen, readHookData, normalizePostToolEvent, findRecentWorkMarker } = require(
  path.join(__dirname, '..', 'lib', 'hook-common')
);

installFailOpen();

// Bridge runtime identity to the work-next child (and any libs reading env):
// codex hook processes carry neither CLAUDE_CODE_SESSION_ID nor a runtime
// pin, so children would misclassify without this.
function bridgeRuntimeEnv(rt, evt) {
  if (!process.env.AGENT_RUNTIME) process.env.AGENT_RUNTIME = rt.name;
  if (!process.env.AGENT_SESSION_ID && evt.sessionId) {
    process.env.AGENT_SESSION_ID = evt.sessionId;
  }
}

// Call work-next.js. Test seam: an absolute path override lets tests stub
// work-next.js without staging the entire plugin tree. Production code never
// sets WORK_NEXT_PATH; default resolves the sibling as before.
function runWorkNext(marker) {
  const workNextPath = process.env.WORK_NEXT_PATH || path.join(__dirname, '..', 'work-next.js');
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

  // Parse instruction
  try {
    return JSON.parse(result);
  } catch {
    process.exit(0);
  }
}

// Output the instruction for the AI to see. On claude the emitted bytes
// match the previous console.log sequence exactly; on codex the same text
// rides the additionalContext envelope (plain PostToolUse stdout is not
// injected there).
const BANNERS = {
  execute: ['═══ WORK2: NEXT STEP ═══', '════════════════════════'],
  complete: ['═══ WORK2: COMPLETE ═══', '═══════════════════════'],
  blocked: ['═══ WORK2: BLOCKED ═══', '══════════════════════'],
};

function emitInstruction(rt, instruction) {
  const banner = BANNERS[instruction.action];
  if (banner) {
    rt.emit.context(
      'PostToolUse',
      ['', banner[0], JSON.stringify(instruction, null, 2), banner[1], ''].join('\n')
    );
  }
}

function main() {
  const hookData = readHookData();
  if (!hookData) process.exit(0);

  const { rt, evt } = normalizePostToolEvent(hookData);

  // Guard: do NOT fire inside sub-agents (would advance state while agent is working)
  if (rt.isSubagentContext(evt)) process.exit(0);

  bridgeRuntimeEnv(rt, evt);

  const found = findRecentWorkMarker();
  if (!found) process.exit(0);

  const instruction = runWorkNext(found.marker);
  emitInstruction(rt, instruction);

  process.exit(0);
}

/**
 * firePostToolCall — dispatch the OnPostToolCall extension event before the
 * existing auto-advance logic, gated on an active /work marker. Errors are
 * swallowed so a misbehaving extension can never crash the hook.
 *
 * @param {{toolName: string, toolInput: any, toolResult: any, tasksDir: string, repoRoot: string}} args
 * @param {{ findActiveMarker?: Function, initExtensions?: Function }} [deps]
 * @returns {void}
 */
function resolveExtensions(args, deps) {
  const { resolveHookExtensions } = require(
    path.join(__dirname, '..', 'lib', 'extensions', 'hook-dispatch')
  );
  return resolveHookExtensions(args, deps);
}

function firePostToolCall(args, deps) {
  const { toolName, toolInput, toolResult, tasksDir, repoRoot } = args || {};
  const api = resolveExtensions({ tasksDir, repoRoot }, deps);
  if (!api) return;
  try {
    api.dispatch('OnPostToolCall', { toolName, toolInput, toolResult });
  } catch {
    /* fail-open — extension dispatch errors must never crash the hook */
  }
}

/**
 * dispatchMatchedHandlers — for each registered `OnAgentResponseMatched`
 * handler whose compiled `match` regex hits `responseText`, dispatch with the
 * matched substring. Per-handler dispatch errors are swallowed.
 *
 * @param {{listHandlers?: Function, dispatch: Function}} api
 * @param {string} responseText
 * @returns {void}
 */
function dispatchMatchedHandlers(api, responseText) {
  const handlers =
    typeof api.listHandlers === 'function' ? api.listHandlers('OnAgentResponseMatched') : [];
  for (const record of handlers) {
    const compiled = record?.match?.compiled;
    if (!compiled) continue;
    const m = compiled.exec(responseText || '');
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
}

/**
 * fireAgentResponseMatched — dispatch `OnAgentResponseMatched` to handlers whose
 * compiled `match` regex hits the response text. Gated on an active /work
 * marker. Errors are swallowed so a misbehaving extension can never crash the
 * hook.
 *
 * Dispatch payload (G9): `{ responseText, match: { pattern, substring } }`.
 *
 * @param {{responseText: string, tasksDir: string, repoRoot: string}} args
 * @param {{ findActiveMarker?: Function, initExtensions?: Function }} [deps]
 * @returns {void}
 */
function fireAgentResponseMatched(args, deps) {
  const { responseText, tasksDir, repoRoot } = args || {};
  const api = resolveExtensions({ tasksDir, repoRoot }, deps);
  if (!api) return;
  try {
    dispatchMatchedHandlers(api, responseText);
  } catch {
    /* fail-open */
  }
}

module.exports = { firePostToolCall, fireAgentResponseMatched };

// WORK_HOOK_NO_MAIN lets tests require this module without running the hook.
if (!process.env.WORK_HOOK_NO_MAIN) {
  main();
}

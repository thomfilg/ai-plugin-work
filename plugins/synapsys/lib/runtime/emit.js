// GENERATED — edit factories/runtime/emit.js and run scripts/sync-vendored.js

'use strict';

/**
 * emit.js — every hook emission terminates or writes through here.
 *
 * The claude branch reproduces today's bytes exactly (stderr+exit 2 blocks,
 * the synapsys emitDeny JSON shape, heimdall's bare updatedInput rewrite,
 * console.log context lines). The codex branch emits only response forms the
 * codex 0.142.5 parser accepts (ground truth §2.6):
 *   - exit-2 blocks MUST have non-empty stderr (empty ⇒ hook FAILS open),
 *     so empty reasons are padded on both runtimes;
 *   - `updatedInput` is only valid together with permissionDecision:'allow'
 *     (+ non-empty reason) — on claude adding 'allow' would auto-approve past
 *     the user's permission prompt, so claude keeps the bare form (C16);
 *   - PostToolUse/PreToolUse plain stdout is NOT injected — context rides the
 *     hookSpecificOutput.additionalContext envelope (C2);
 *   - UPS/SessionStart/SubagentStart plain stdout that LOOKS like JSON (leading
 *     `{`/`[`/`"`) is parsed, fails, and is dropped — guarded with a lead-in
 *     line (WP-12 scenario B root cause; see guardStdoutContext);
 *   - Stop-event context has no codex channel — suppressed (callers persist
 *     state themselves; the /work state machine already does).
 * NEVER emitted on codex: decision:'approve', permissionDecision:'ask', bare
 * 'allow', continue:false / suppressOutput / updatedMCPToolOutput on tool
 * events (§2.6.3–2.6.5).
 */

const EMPTY_REASON_PAD = 'Blocked by hook (no reason provided).';
const STDOUT_CONTEXT_EVENTS = new Set(['UserPromptSubmit', 'SessionStart', 'SubagentStart']);
const TOOL_CONTEXT_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

// Codex JSON-sniff guard (GT §2.6.1 + WP-12 recon probes, 2026-07-07): exit-0
// stdout whose first non-whitespace char is `{`, `[` or `"` is sniffed as
// JSON; when it is not a valid per-event response the hook is marked Failed
// and the text is DROPPED (live: synapsys '[synapsys:local] …' lost, scenario
// B) — and a Failed hook can race SIBLING hooks out of their injections
// (recon-ss/recon-tool probes: same 3-hook batch lost different members per
// run). A one-line lead-in defeats the sniff; the payload stays verbatim.
// Claude is lenient (invalid JSON ⇒ plain text), so claude bytes never change.
const JSON_LOOKING_RE = /^\s*["[{]/;
const CODEX_STDOUT_LEAD_IN = 'hook context:';

/**
 * Make a plain-stdout context payload safe for the codex JSON sniff. Identity
 * on claude and on already-safe text.
 */
function guardStdoutContext(runtime, text) {
  const s = text == null ? '' : String(text);
  if (runtime !== 'codex') return s;
  return JSON_LOOKING_RE.test(s) ? `${CODEX_STDOUT_LEAD_IN}\n${s}` : s;
}

function pad(reason) {
  const text = reason == null ? '' : String(reason);
  return text.trim() === '' ? EMPTY_REASON_PAD : text;
}

/** Pure channel resolution for context(event, text) — unit-testable. */
function contextChannel(runtime, event) {
  if (runtime !== 'codex') return 'stdout';
  if (STDOUT_CONTEXT_EVENTS.has(event)) return 'stdout';
  if (TOOL_CONTEXT_EVENTS.has(event)) return 'envelope';
  return 'suppressed';
}

/** Pure renderer for context(event, text): { channel, output }. */
function renderContext(runtime, event, text) {
  const channel = contextChannel(runtime, event);
  if (channel === 'stdout') return { channel, output: `${guardStdoutContext(runtime, text)}\n` };
  if (channel === 'envelope') {
    const envelope = { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
    return { channel, output: `${JSON.stringify(envelope)}\n` };
  }
  return { channel, output: '' };
}

/** Pure renderer for allowWithUpdatedCommand — the C16 per-runtime pairing. */
function renderUpdatedCommand(runtime, command, reason) {
  const hookSpecificOutput =
    runtime === 'codex'
      ? {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: pad(reason),
          updatedInput: { command },
        }
      : { hookEventName: 'PreToolUse', updatedInput: { command } };
  return JSON.stringify({ hookSpecificOutput });
}

/**
 * Build the emit facet for one runtime. All members except context() exit the
 * process and never return.
 */
function createEmit(runtime) {
  return {
    block(reason) {
      process.stderr.write(pad(reason));
      process.exit(2);
    },
    deny(reason) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: pad(reason),
          },
        })
      );
      process.exit(0);
    },
    allowWithUpdatedCommand(command, reason) {
      process.stdout.write(renderUpdatedCommand(runtime, command, reason));
      process.exit(0);
    },
    context(event, text) {
      const rendered = renderContext(runtime, event, text);
      if (rendered.output) process.stdout.write(rendered.output);
    },
    stopContinue(reason) {
      process.stdout.write(`${JSON.stringify({ decision: 'block', reason: pad(reason) })}\n`);
      process.exit(0);
    },
    silent() {
      process.exit(0);
    },
  };
}

module.exports = {
  createEmit,
  contextChannel,
  renderContext,
  renderUpdatedCommand,
  guardStdoutContext,
  pad,
  EMPTY_REASON_PAD,
  CODEX_STDOUT_LEAD_IN,
};

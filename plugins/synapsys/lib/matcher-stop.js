'use strict';

/**
 * Stop-event matcher and the agent-response surface extractor for the
 * `trigger_stop_response` field. Split out of matcher.js so matcher.js stays
 * under the quality gate's max-lines budget; same self-contained pattern as
 * matcher-content.js / matcher-excludes.js.
 */

// Resolve the assistant-side text surface that trigger_stop_response evaluates
// against. Strictly excludes tool inputs and tool results: only the assistant's
// natural-language response counts. Reads payload.response, falling back to
// payload.assistant_response, then payload.last_assistant_message (the codex
// Stop payload's native field — ground truth §2.5.2; Claude Stop payloads
// never carry it, so the claude path is unchanged), then payload.transcript.
// Returns '' otherwise.
function _extractStopResponse(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.response === 'string') return payload.response;
  if (typeof payload.assistant_response === 'string') return payload.assistant_response;
  if (typeof payload.last_assistant_message === 'string') return payload.last_assistant_message;
  if (typeof payload.transcript === 'string') return payload.transcript;
  return '';
}

// Stop event fires at the assistant's turn end. The classifier matrix assigns
// Stop to memories that are retrospective checks ("did I run follow-up-pr?",
// "cleanup the tmp file"). A memory with NO `trigger_stop_response` never
// fires on Stop: Stop stdout does not reach the model, so an unconditional
// fire would only churn the ledger/telemetry every turn end (fail-open noise
// with zero signal). When the field is present, the memory only fires if the
// assistant's response (NOT tool inputs/results) matches the regex.
//
// @param {object} memory
// @param {object} [payload] Stop hook payload; consulted only when
//   memory.triggerStopResponse is set.
// @param {{gateMemory, safeRegex, makeMatched}} helpers shared utilities from matcher.js
function matchStop(memory, payload, helpers) {
  const { gateMemory, safeRegex, makeMatched } = helpers;
  const gate = gateMemory(memory, 'Stop');
  if (gate) return { fired: false, reason: gate };
  if (!memory.triggerStopResponse) {
    return { fired: false, reason: 'no-stop-response-configured' };
  }

  const regex = safeRegex(memory.triggerStopResponse, 'i');
  if (!regex) {
    process.stderr.write(
      `[synapsys] memory ${memory.name}: invalid trigger_stop_response regex "${memory.triggerStopResponse}"\n`
    );
    return { fired: false, reason: 'no-stop-response-match' };
  }

  const text = _extractStopResponse(payload);
  const m = regex.exec(text);
  if (!m) return { fired: false, reason: 'no-stop-response-match' };
  return { fired: true, matched: makeMatched({ stop_response_substring: m[0] }) };
}

module.exports = {
  matchStop,
  _extractStopResponse,
};

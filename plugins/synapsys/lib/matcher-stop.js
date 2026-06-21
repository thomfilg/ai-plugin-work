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
// payload.assistant_response, then payload.transcript. Returns '' otherwise.
function _extractStopResponse(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.response === 'string') return payload.response;
  if (typeof payload.assistant_response === 'string') return payload.assistant_response;
  if (typeof payload.transcript === 'string') return payload.transcript;
  return '';
}

// Stop event fires at the assistant's turn end. The classifier matrix assigns
// Stop to memories that are retrospective checks ("did I run follow-up-pr?",
// "cleanup the tmp file"). When `triggerStopResponse` is absent, the memory
// fires unconditionally for any Stop hook (backward-compat). When present, the
// memory only fires if the assistant's response (NOT tool inputs/results)
// matches the regex.
//
// @param {object} memory
// @param {object} [payload] Stop hook payload; consulted only when
//   memory.triggerStopResponse is set.
// @param {{gateMemory, safeRegex, makeMatched}} helpers shared utilities from matcher.js
function matchStop(memory, payload, helpers) {
  const { gateMemory, safeRegex, makeMatched } = helpers;
  const gate = gateMemory(memory, 'Stop');
  if (gate) return { fired: false, reason: gate };
  if (!memory.triggerStopResponse) return { fired: true };

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

'use strict';

/**
 * emitMatched — telemetry + behavior-changed expectation recording for the
 * matched memory set. Extracted from the dispatcher hook (synapsys.js) to keep
 * that file under the 400-line cap after merging onto current main.
 *
 * Fail-open: every record call is wrapped so telemetry/expectation failures
 * never block the dispatch.
 */

const path = require('node:path');
const { recordFired, isDisabled } = require(path.join(__dirname, '..', '..', 'lib', 'telemetry'));
const { expectedCommandsFor } = require(path.join(__dirname, 'behavior-changed'));
const pretoolWindow = require(path.join(__dirname, '..', '..', 'lib', 'pretool-window'));

function emitMatched(matched, payload, event, sessionId) {
  if (!matched.length) return;
  for (const m of matched) {
    try {
      recordFired(m, payload, event);
    } catch {
      // fail-open
    }
    // Path A: when a memory with a trigger_pretool rule fires on PreToolUse,
    // record the expected command so a subsequent divergent PreToolUse can
    // surface a one-off behavior_changed event.
    if (event === 'PreToolUse' && !isDisabled(m)) {
      const expectedAll = expectedCommandsFor(m);
      if (expectedAll.length > 0) {
        try {
          pretoolWindow.recordExpectation(sessionId, m.name, expectedAll);
        } catch {
          // fail-open
        }
      }
    }
  }
}

module.exports = { emitMatched };

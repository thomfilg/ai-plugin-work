'use strict';

/**
 * PostToolUse-event matcher. Inspects the tool OUTPUT (`tool_response`,
 * stringified) plus the process exit code — DISTINCT from matchPreToolResult,
 * which reads `tool_input`. Split out of matcher.js (same self-contained
 * sub-module pattern as matcher-stop.js / matcher-content.js) so matcher.js
 * stays under the quality gate's max-lines budget. The shared helpers
 * (gateMemory, safeRegex, makeMatched, pretoolSpecMatches) are injected from
 * matcher.js at re-bind time; the field-agnostic content helpers
 * (findContentMatchInPatterns / evaluateContentNot) are required directly from
 * matcher-content.js — the matcher-stop.js sibling-require pattern — so the
 * regex-list loop bodies live in exactly one place (jscpd clone removal).
 */

const { findContentMatchInPatterns, evaluateContentNot } = require('./matcher-content');

// Resolve the tool-output text surface that the trigger_posttool_* gates
// evaluate against. A string tool_response passes through verbatim; an object
// response (e.g. { stdout, stderr, exit_code }) is JSON-stringified so its
// fields are searchable. Returns '' when no usable response is present.
function _extractPostToolResponse(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const resp = payload.tool_response;
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  return _stringifyResponse(resp);
}

// Stringify a non-string tool_response. Isolated as a named helper so the
// passthrough branch above stays a single readable expression.
function _stringifyResponse(resp) {
  try {
    return JSON.stringify(resp);
  } catch {
    return String(resp);
  }
}

// Resolve the process exit code from the payload, in the locked read order:
//   tool_response.exit_code → tool_response.exitCode → payload.exit_code.
// Returns undefined when none is present (caller fails closed).
function _resolveExitCode(payload) {
  const resp = payload && payload.tool_response;
  if (resp && typeof resp === 'object') {
    if (typeof resp.exit_code === 'number') return resp.exit_code;
    if (typeof resp.exitCode === 'number') return resp.exitCode;
  }
  if (payload && typeof payload.exit_code === 'number') return payload.exit_code;
  return undefined;
}

// Predicate half of the exit gate: does the resolved exit `code` satisfy the
// `spec` ('zero' / 'nonzero' / a specific numeric-or-string code)? Split out of
// _evaluatePostToolExit to keep each function under the complexity gate.
function _exitCodeMatches(spec, code) {
  if (spec === 'zero' || spec === 0 || spec === '0') return code === 0;
  if (spec === 'nonzero') return code !== 0;
  const wanted = typeof spec === 'number' ? spec : Number(spec);
  if (Number.isNaN(wanted)) return false;
  return code === wanted;
}

// Final content/exit-stage gate (C-1): evaluate trigger_posttool_exit against
// the resolved exit code. Accepts 'zero' / 'nonzero' / a specific numeric code.
// Fails closed (matched:false) when the field is set but no exit code is
// present anywhere in the payload (P0-5d).
//
// @returns {{ matched: boolean, signal?: string|number }}
function _evaluatePostToolExit(memory, payload) {
  const spec = memory.triggerPosttoolExit;
  if (spec === null || spec === undefined) return { matched: true };
  const code = _resolveExitCode(payload);
  if (code === undefined) return { matched: false };
  return _exitCodeMatches(spec, code) ? { matched: true, signal: spec } : { matched: false };
}

// Stage 2 (C-1): positive trigger_pretool prefix gate. The event-agnostic
// trigger_pretool list targets the tool/path; it is evaluated against
// tool_name + stringified tool_input (P0-4). Returns the matched spec on hit,
// or null on miss. An EMPTY trigger_pretool is not a miss — it means no
// tool/path restriction (output-inspection mode, brief P0-4): the gate passes
// vacuously and targeting falls to the content/exit stage, matching the lint
// rule (R11) that treats trigger_posttool_content / _exit as standalone
// targeting. Distinguished from a real miss via _hasPretoolTarget below.
function _matchPretoolPrefix(memory, payload, pretoolSpecMatches) {
  if (!memory.triggerPretool || !memory.triggerPretool.length) return null;
  const toolName = payload?.tool_name || '';
  const argBlob = JSON.stringify(payload?.tool_input || {});
  return (
    memory.triggerPretool.find((spec) => pretoolSpecMatches(spec, toolName, argBlob)) || null
  );
}

// True when the memory declares a non-empty trigger_pretool target — i.e. an
// unmatched prefix is a real 'no-pretool-match' miss (not the vacuous
// output-inspection pass-through of an empty target).
function _hasPretoolTarget(memory) {
  return Array.isArray(memory.triggerPretool) && memory.triggerPretool.length > 0;
}

// Find the first matching positive trigger_posttool_content pattern against the
// stringified tool_response. Delegates to the shared field-agnostic helper,
// pinning the POSTTOOL content field + warning label (the pretool surface reads
// triggerPretoolContent, the wrong field for PostToolUse). Invalid regexes are
// warned-and-skipped (C-5) inside the helper.
function _findPosttoolContentMatch(memory, responseText) {
  return findContentMatchInPatterns(memory.triggerPosttoolContent, responseText, {
    label: 'trigger_posttool_content',
    memoryName: memory.name,
  });
}

// Evaluate the trigger_posttool_content_not AND-NOT gate against the stringified
// tool_response. Delegates to the shared field-agnostic helper, pinning the
// POSTTOOL negative field + warning label. Invalid regexes are warned-and-
// skipped (C-5) inside the helper.
function _evaluatePosttoolContentNot(memory, responseText) {
  return evaluateContentNot(memory.triggerPosttoolContentNot, responseText, {
    label: 'trigger_posttool_content_not',
    memoryName: memory.name,
  });
}

// Stage 3 (C-1): content gate over the tool_response surface. Runs the positive
// trigger_posttool_content match then the trigger_posttool_content_not AND-NOT
// gate with negative-excludes priority. Operates on the POSTTOOL content fields.
//
// @returns one of:
//   { ok: true, hit?: { pattern, substring } }
//   { ok: false, reason: 'no-content-match' }
//   { ok: false, reason: 'negative-excludes', negative: { pattern } }
function _evaluateContentStage(memory, responseText) {
  const hasPositive =
    Array.isArray(memory.triggerPosttoolContent) && memory.triggerPosttoolContent.length > 0;
  if (!hasPositive) return { ok: true };

  const hit = _findPosttoolContentMatch(memory, responseText);
  if (!hit) return { ok: false, reason: 'no-content-match' };

  const negative = _evaluatePosttoolContentNot(memory, responseText);
  if (negative.excluded) {
    return { ok: false, reason: 'negative-excludes', negative: { pattern: negative.pattern } };
  }
  return { ok: true, hit };
}

/**
 * matchPostTool — fire a PostToolUse memory against a tool's OUTPUT.
 *
 * Locked evaluation order (GH-510, C-1):
 *   1. events / disabled / expired gate (injected gateMemory)
 *   2. positive trigger_pretool prefix      → 'no-pretool-match' on miss
 *   3. content/exit stage over tool_response:
 *        positive trigger_posttool_content   → 'no-content-match'
 *        then     trigger_posttool_content_not → 'negative-excludes' (priority)
 *        then     trigger_posttool_exit        → 'no-exit-match'
 *   4. exclude_* suppression                  → 'exclude-matched'
 *
 * Never throws (C-5): invalid content regexes are warned-and-skipped inside the
 * injected findContentMatch/evaluatePretoolContentNot helpers.
 *
 * @param {object} memory
 * @param {object} payload PostToolUse hook payload (tool_name, tool_input,
 *   tool_response, exit_code).
 * @param {object} helpers shared utilities injected from matcher.js.
 * @returns {{ fired: boolean, reason?: string, matched?: object }}
 */
// Stage 4 (C-1): exclude_* suppression veto. Mirrors matchPreTool's stage-4 —
// exclude_pretool / exclude_preset are evaluated against tool_name + tool_input
// (the same target the trigger_pretool prefix considered). Returns the
// makeMatched diagnostics on a hit, or null when nothing excludes.
function _evaluatePostToolExcludes(memory, payload, evaluateExcludePretool, makeMatched) {
  const toolName = payload?.tool_name || '';
  const argBlob = JSON.stringify(payload?.tool_input || {});
  const excluded = evaluateExcludePretool(memory, toolName, argBlob);
  if (excluded.excluded) {
    return makeMatched({ excluded_pattern: excluded.pattern });
  }
  return null;
}

function matchPostTool(memory, payload, helpers) {
  const { gateMemory, makeMatched, pretoolSpecMatches, evaluateExcludePretool } = helpers;

  // Stage 1: events / disabled / expired.
  const gate = gateMemory(memory, 'PostToolUse');
  if (gate) return { fired: false, reason: gate };

  // Stage 2: positive trigger_pretool prefix over tool_name + tool_input. An
  // empty target passes vacuously (output-inspection mode, brief P0-4); a
  // declared-but-unmatched target is a real miss.
  const matchedSpec = _matchPretoolPrefix(memory, payload, pretoolSpecMatches);
  if (_hasPretoolTarget(memory) && !matchedSpec) {
    return { fired: false, reason: 'no-pretool-match' };
  }

  // Stage 3a: positive/negative content over the stringified tool_response.
  const responseText = _extractPostToolResponse(payload);
  const contentStage = _evaluateContentStage(memory, responseText);
  if (!contentStage.ok) {
    if (contentStage.reason === 'negative-excludes') {
      return {
        fired: false,
        reason: 'negative-excludes',
        matched: makeMatched({
          pretool_pattern: matchedSpec,
          negative_pattern: contentStage.negative.pattern,
        }),
      };
    }
    return { fired: false, reason: 'no-content-match' };
  }

  // Stage 3b: exit-code gate (final content/exit stage).
  const exitStage = _evaluatePostToolExit(memory, payload);
  if (!exitStage.matched) return { fired: false, reason: 'no-exit-match' };

  // Stage 4: exclude_* suppression. Runs AFTER content/exit so negative-excludes
  // retains priority over exclude-matched (locked order, GH-510).
  const excludedMatched = _evaluatePostToolExcludes(
    memory,
    payload,
    evaluateExcludePretool,
    makeMatched
  );
  if (excludedMatched) {
    return { fired: false, reason: 'exclude-matched', matched: excludedMatched };
  }

  return {
    fired: true,
    matched: makeMatched({
      pretool_pattern: matchedSpec,
      posttool_content_pattern: contentStage.hit?.pattern,
      posttool_content_substring: contentStage.hit?.substring,
      posttool_exit: exitStage.signal,
    }),
  };
}

module.exports = {
  matchPostTool,
  _extractPostToolResponse,
  _evaluatePostToolExit,
};

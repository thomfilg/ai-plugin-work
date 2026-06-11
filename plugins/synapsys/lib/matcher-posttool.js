'use strict';

/**
 * PostToolUse-event matcher. Inspects the tool OUTPUT (`tool_response`,
 * stringified) plus the process exit code — DISTINCT from matchPreToolResult,
 * which reads `tool_input`. Split out of matcher.js (same self-contained
 * sub-module pattern as matcher-stop.js / matcher-content.js) so matcher.js
 * stays under the quality gate's max-lines budget. The shared helpers
 * (gateMemory, safeRegex, makeMatched, pretoolSpecMatches, findContentMatch,
 * hasNegativeContentPatterns, evaluatePretoolContentNot) are injected from
 * matcher.js at re-bind time.
 */

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

  if (spec === 'zero' || spec === 0 || spec === '0') {
    return code === 0 ? { matched: true, signal: spec } : { matched: false };
  }
  if (spec === 'nonzero') {
    return code !== 0 ? { matched: true, signal: spec } : { matched: false };
  }
  const wanted = typeof spec === 'number' ? spec : Number(spec);
  if (Number.isNaN(wanted)) return { matched: false };
  return code === wanted ? { matched: true, signal: spec } : { matched: false };
}

// Stage 2 (C-1): positive trigger_pretool prefix gate. The event-agnostic
// trigger_pretool list targets the tool/path; it is evaluated against
// tool_name + stringified tool_input (P0-4). Returns the matched spec on hit,
// or null on miss.
function _matchPretoolPrefix(memory, payload, pretoolSpecMatches) {
  if (!memory.triggerPretool || !memory.triggerPretool.length) return null;
  const toolName = payload?.tool_name || '';
  const argBlob = JSON.stringify(payload?.tool_input || {});
  return (
    memory.triggerPretool.find((spec) => pretoolSpecMatches(spec, toolName, argBlob)) || null
  );
}

// Find the first matching positive trigger_posttool_content pattern against the
// stringified tool_response. Mirrors matcher-content.findContentMatch but reads
// the POSTTOOL content field (the injected pretool helper reads triggerPretoolContent,
// the wrong surface for PostToolUse). Invalid regexes are warned-and-skipped (C-5).
function _findPosttoolContentMatch(memory, responseText) {
  const patterns = memory.triggerPosttoolContent;
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  for (const pat of patterns) {
    let re;
    try {
      re = new RegExp(pat, 'im');
    } catch (err) {
      process.stderr.write(
        `[synapsys] memory ${memory.name}: invalid trigger_posttool_content regex "${pat}": ${err.message}\n`
      );
      continue;
    }
    const m = re.exec(responseText);
    if (m) return { pattern: pat, substring: m[0] };
  }
  return null;
}

// Evaluate the trigger_posttool_content_not AND-NOT gate against the stringified
// tool_response. Mirrors matcher-content.evaluatePretoolContentNot but reads the
// POSTTOOL negative field. Invalid regexes are warned-and-skipped (C-5).
function _evaluatePosttoolContentNot(memory, responseText) {
  const patterns = memory.triggerPosttoolContentNot;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { excluded: false, pattern: null };
  }
  for (const pat of patterns) {
    let re;
    try {
      re = new RegExp(pat, 'im');
    } catch (err) {
      process.stderr.write(
        `[synapsys] memory ${memory.name}: invalid trigger_posttool_content_not regex "${pat}": ${err.message}\n`
      );
      continue;
    }
    if (re.test(responseText)) return { excluded: true, pattern: pat };
  }
  return { excluded: false, pattern: null };
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
function matchPostTool(memory, payload, helpers) {
  const { gateMemory, makeMatched, pretoolSpecMatches } = helpers;

  // Stage 1: events / disabled / expired.
  const gate = gateMemory(memory, 'PostToolUse');
  if (gate) return { fired: false, reason: gate };

  // Stage 2: positive trigger_pretool prefix over tool_name + tool_input.
  const matchedSpec = _matchPretoolPrefix(memory, payload, pretoolSpecMatches);
  if (!matchedSpec) return { fired: false, reason: 'no-pretool-match' };

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

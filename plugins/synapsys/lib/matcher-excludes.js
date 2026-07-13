'use strict';

/**
 * Stage-4 exclude evaluators (`exclude_prompt`/`exclude_preset` resolved list
 * and `exclude_pretool` specs). Split out of matcher.js so the locked stage
 * ladder file stays under the quality gate's max-lines budget without
 * compromising the explainer contract.
 */

const { safeRegex } = require('./matcher-regex');

/**
 * True when the memory carries any exclude signal (resolved prompt/preset
 * list, or any `exclude_pretool` spec).
 *
 * @param {object} memory
 * @returns {boolean}
 */
function hasExcludePatterns(memory) {
  const resolved = Array.isArray(memory.excludeResolved) && memory.excludeResolved.length > 0;
  const pretool = Array.isArray(memory.excludePretool) && memory.excludePretool.length > 0;
  return resolved || pretool;
}

/**
 * Evaluate the resolved exclude list (inline `exclude_prompt` + flattened
 * `exclude_preset` bodies, in `memory.excludeResolved`) against an input
 * string (typically a user prompt or a stringified tool_input blob).
 * Invalid regex entries are skipped with a stderr warning so a single bad
 * pattern cannot abort the matcher (fail-closed / R15).
 *
 * @param {object} memory
 * @param {string} input
 * @returns {{ excluded: boolean, pattern: string|null }}
 */
function evaluateExcludePrompt(memory, input) {
  const patterns = memory.excludeResolved;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { excluded: false, pattern: null };
  }
  const text = input || '';
  // Two-pass evaluation:
  //   pass 1 — compile every pattern, emit stderr warnings for invalid ones
  //            so memory authors are told about all bad regex even when an
  //            earlier valid one matches (fail-closed / R15).
  //   pass 2 — return on the first valid regex that matches.
  const compiled = [];
  for (const pat of patterns) {
    const re = safeRegex(pat);
    if (!re) {
      process.stderr.write(`[synapsys] memory ${memory.name}: invalid exclude regex "${pat}"\n`);
      continue;
    }
    compiled.push({ pat, re });
  }
  for (const { pat, re } of compiled) {
    if (re.test(text)) return { excluded: true, pattern: pat };
  }
  return { excluded: false, pattern: null };
}

/**
 * Evaluate `memory.excludePretool` (array of `tool:pattern` specs sharing the
 * shape of `trigger_pretool`) against a candidate (toolName, argBlob).
 * Caller passes the shared `parsePretoolSpec` / `pretoolSpecMatches` helpers
 * from matcher.js so the spec grammar stays in one place.
 *
 * @param {object} memory
 * @param {string} toolName
 * @param {string} argBlob
 * @param {{ parsePretoolSpec: Function, pretoolSpecMatches: Function }} helpers
 * @returns {{ excluded: boolean, pattern: string|null }}
 */
function evaluateExcludePretool(memory, toolName, argBlob, helpers) {
  const specs = memory.excludePretool;
  if (!Array.isArray(specs) || specs.length === 0) {
    return { excluded: false, pattern: null };
  }
  const { parsePretoolSpec, pretoolSpecMatches } = helpers;
  // Two-pass evaluation mirrors evaluateExcludePrompt (R15 fail-closed):
  //   pass 1 — pre-validate each spec's regex and emit stderr warnings for
  //            invalid patterns so authors learn about every bad regex,
  //            even when an earlier valid spec matches.
  //   pass 2 — return on the first valid spec that matches.
  // `pretoolSpecMatches` calls `safeRegex` which silently returns null on
  // invalid input, so without this validation a bad pattern would be a
  // silent no-op rather than a documented warn+skip.
  const valid = [];
  for (const spec of specs) {
    const { pat } = parsePretoolSpec(spec);
    if (pat && !safeRegex(pat)) {
      process.stderr.write(
        `[synapsys] memory ${memory.name}: invalid exclude_pretool spec "${spec}"\n`
      );
      continue;
    }
    valid.push(spec);
  }
  for (const spec of valid) {
    try {
      if (pretoolSpecMatches(spec, toolName, argBlob || '')) {
        return { excluded: true, pattern: spec };
      }
    } catch (err) {
      process.stderr.write(
        `[synapsys] memory ${memory.name}: invalid exclude_pretool spec "${spec}": ${err.message}\n`
      );
    }
  }
  return { excluded: false, pattern: null };
}

module.exports = {
  hasExcludePatterns,
  evaluateExcludePrompt,
  evaluateExcludePretool,
};

'use strict';

/**
 * Output formatters for synapsys-lint (JSON envelope + human-readable).
 *
 * Split out of `scripts/synapsys-lint.js` (GH-534) for file-size cap.
 */

function formatJson(result) {
  return JSON.stringify({
    warnings: result.warnings,
    errors: result.errors,
    pairs: result.pairs,
    broadTriggers: result.broadTriggers,
  });
}

/**
 * formatRate — canonical numeric formatter for human-readable overlap rates.
 * Integer scores (Task-5 body match counts) render as-is; jaccard fractions
 * render to two decimal places.
 */
function formatRate(score) {
  if (typeof score !== 'number') return String(score);
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

/**
 * humanCauseLine — one-line summary of why the pair was flagged.
 */
function humanCauseLine(pair) {
  if (pair.rule === 'trigger-body-overlap') {
    const matched = Array.isArray(pair.matchedTokens) ? pair.matchedTokens.join(', ') : '';
    return `cause: trigger-body-overlap — ${pair.b}'s trigger matched ${pair.score}× in ${pair.a}'s body${matched ? ` (tokens: ${matched})` : ''}`;
  }
  if (pair.rule === 'pretool-overlap') {
    return `cause: pretool-overlap on tool \`${pair.tool}\` (jaccard=${formatRate(pair.score)})`;
  }
  return `cause: trigger-overlap (jaccard=${formatRate(pair.score)})`;
}

/**
 * formatHuman — AC-G10: for each pair, emit four lines in order:
 *   1. pair header `A ⇄ B`
 *   2. cause line
 *   3. suggestion line
 *   4. overlap rate + `[severity: <tier>]` tag (single line)
 *
 * Broad-trigger entries follow the pair blocks under a separate heading.
 */
function formatHuman(result) {
  const lines = [];
  if (result.pairs.length === 0 && result.broadTriggers.length === 0) {
    lines.push('synapsys-lint: no overlap pairs or broad triggers reported.');
    return lines.join('\n');
  }
  for (const p of result.pairs) {
    lines.push(`${p.a} ⇄ ${p.b}`);
    lines.push(`  ${humanCauseLine(p)}`);
    lines.push(`  suggestion: ${p.suggestion || ''}`);
    lines.push(`  overlap=${formatRate(p.score)} [severity: ${p.severity}]`);
    lines.push('');
  }
  if (result.broadTriggers.length > 0) {
    lines.push('broad triggers:');
    for (const e of result.broadTriggers) {
      lines.push(`  - ${e.name}: ${e.reason} [severity: ${e.severity}]`);
    }
  }
  return lines.join('\n').replace(/\n+$/, '');
}

module.exports = { formatJson, formatHuman, formatRate, humanCauseLine };

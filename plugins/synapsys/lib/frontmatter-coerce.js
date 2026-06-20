'use strict';

/**
 * Frontmatter value-coercion machinery, extracted from memory-store.js so that
 * file stays under the quality gate's max-lines budget. Parsing semantics are
 * IDENTICAL to the originals — this is a pure relocation. Exports:
 *   - BRACKET_LIST_KEYS  : keys whose `[…]` value is parsed as a YAML-style list
 *   - coerceFrontmatterValue(raw, key)
 *   - toList(value)
 */

// Frontmatter keys whose `[...]` value should be parsed as a YAML-style list.
// All other keys keep `[...]` as a literal string so regex character classes
// like `[a-z0-9]` in `trigger_prompt` aren't mis-coerced into arrays.
const BRACKET_LIST_KEYS = new Set([
  'domain',
  'events',
  'trigger_pretool',
  'trigger_pretool_content',
  'trigger_pretool_content_not',
  'trigger_posttool_content',
  'trigger_posttool_content_not',
  'cite_signals',
  'exclude_pretool',
  'exclude_preset',
]);

function coerceFrontmatterValue(raw, key) {
  const val = raw.trim();
  if (val === '') return '';
  if (val === 'true') return true;
  if (val === 'false') return false;
  // Bracket-array form: only treat `[…]` as a list for known list-typed keys.
  // Regex character classes (e.g. `[a-z0-9]` in `trigger_prompt`) must stay as
  // strings, so we gate by key rather than by content shape.
  if (BRACKET_LIST_KEYS.has(key) && /^\[[\s\S]*\]$/.test(val)) {
    return val
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (/^["'].*["']$/.test(val)) return val.slice(1, -1);
  return val;
}

// Normalize a frontmatter value into an array of non-empty trimmed strings.
// Already-array values pass through; a scalar is comma-split.
function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  BRACKET_LIST_KEYS,
  coerceFrontmatterValue,
  toList,
};

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
  'behavior_signals',
  'exclude_pretool',
  'exclude_preset',
]);

// Split a comma-separated string on TOP-LEVEL commas only. Commas nested
// inside regex constructs — `{1,3}` quantifiers, `[a,b]` character classes,
// `(x,y)` groups — and backslash-escaped commas do NOT split, so a single
// regex spec containing them survives as one list item. Plain comma lists
// (no brackets) split exactly as a naive `.split(',')` would. Unbalanced
// closers never drive the depth negative (clamped), so a stray `}` in one
// item cannot glue the rest of the list together.
const _OPENERS = new Set(['{', '[', '(']);
const _CLOSERS = new Set(['}', ']', ')']);

function _nextDepth(depth, ch) {
  if (_OPENERS.has(ch)) return depth + 1;
  if (_CLOSERS.has(ch) && depth > 0) return depth - 1;
  return depth;
}

function splitTopLevel(str) {
  const out = [];
  let buf = '';
  let depth = 0;
  let escaped = false;
  for (const ch of String(str)) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    depth = _nextDepth(depth, ch);
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function coerceFrontmatterValue(raw, key) {
  const val = raw.trim();
  if (val === '') return '';
  if (val === 'true') return true;
  if (val === 'false') return false;
  // Bracket-array form: only treat `[…]` as a list for known list-typed keys.
  // Regex character classes (e.g. `[a-z0-9]` in `trigger_prompt`) must stay as
  // strings, so we gate by key rather than by content shape.
  if (BRACKET_LIST_KEYS.has(key) && /^\[[\s\S]*\]$/.test(val)) {
    return splitTopLevel(val.slice(1, -1))
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (/^["'].*["']$/.test(val)) return val.slice(1, -1);
  return val;
}

// Normalize a frontmatter value into an array of non-empty trimmed strings.
// Already-array values pass through; a scalar is split on TOP-LEVEL commas
// only (see splitTopLevel) so regex constructs like `{1,3}` or `[a,b]`
// embedded in a single spec don't shatter into broken patterns.
function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return splitTopLevel(String(v))
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  BRACKET_LIST_KEYS,
  coerceFrontmatterValue,
  splitTopLevel,
  toList,
};

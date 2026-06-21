'use strict';

/**
 * Default skip threshold: entries whose `fullText.length` is below this value
 * are never demoted (their full body is small enough to always inject in full).
 * See spec §P0 #3 / brief P0 R3.
 */
const SKIP_DEMOTION_BELOW_DEFAULT = 2000;

/**
 * Compute the rendered character size of `entries`, joining the rendered
 * piece of each entry (its `fullText` when `finalKind === 'full'`, otherwise
 * its `summaryText`) with `sep` between adjacent entries.
 *
 * @param {ReadonlyArray<Entry>} entries
 * @param {string} sep
 * @returns {number}
 */
function renderedSize(entries, sep) {
  if (entries.length === 0) return 0;
  let total = 0;
  for (const e of entries) {
    total += e.finalKind === 'full' ? e.fullText.length : e.summaryText.length;
  }
  total += sep.length * (entries.length - 1);
  return total;
}

// Collect indices of entries currently eligible for demotion (finalKind 'full'
// AND fullText length at or above the skip threshold).
function findDemotableIndices(entries, skipBelow) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.finalKind === 'full' && e.fullText.length >= skipBelow) out.push(i);
  }
  return out;
}

// Demote the highest-indexed demotable entry, reserving the lowest-indexed
// demotable as the rotation anchor (terminal rotation guarantee). Returns
// true iff an entry was demoted in this pass.
function demoteOnePass(entries, demotableIndices) {
  const anchor = demotableIndices[0];
  for (let k = demotableIndices.length - 1; k >= 0; k--) {
    const i = demotableIndices[k];
    if (i === anchor) continue;
    entries[i].finalKind = 'reminder';
    return true;
  }
  return false;
}

/**
 * Reverse-walk demotion: flip `finalKind` from `'full'` to `'reminder'` on
 * demotable entries (last to first) until the total rendered size is `≤ limit`
 * or no demotable entries remain. Pure: mutates the supplied `entries` array
 * in place (and returns it) without performing I/O, reading env vars, or
 * writing to stderr.
 *
 * Invariants:
 *  - **Reverse-walk order**: among demotable entries, the one with the
 *    highest index is demoted first.
 *  - **Skip threshold**: an entry whose `fullText.length < skipBelow` is
 *    never demoted (brief P0 R3).
 *  - **Terminal rotation guarantee**: at least one demotable entry is always
 *    retained in `'full'` form, so the matched set never collapses to
 *    summaries only even when the total still exceeds `limit`
 *    (brief P0 R4 / spec §P0 #4).
 *
 * Entry shape:
 *   {
 *     memory:       object,        // opaque, passed through
 *     initialKind:  'full' | 'reminder',
 *     finalKind:    'full' | 'reminder',  // mutated by this helper
 *     fullText:     string,        // rendered full body
 *     summaryText:  string,        // rendered reminder line
 *   }
 *
 * @template {{ memory: unknown, initialKind: 'full'|'reminder',
 *   finalKind: 'full'|'reminder', fullText: string, summaryText: string }} Entry
 * @param {Entry[]} entries
 * @param {{ limit: number, sep: string, skipBelow?: number }} options
 * @returns {Entry[]} The same `entries` array, with `finalKind` mutated as needed.
 */
function demoteToFit(entries, options) {
  const opts = options || {};
  const limit = opts.limit;
  const sep = opts.sep != null ? opts.sep : '';
  const skipBelow = opts.skipBelow != null ? opts.skipBelow : SKIP_DEMOTION_BELOW_DEFAULT;

  if (!Array.isArray(entries) || entries.length === 0) return entries;

  // Walk REVERSE; demote one demotable entry at a time until total ≤ limit
  // or no demotable entries remain. The terminal rotation guarantee (P0 R4)
  // is enforced by reserving the lowest-indexed demotable as anchor.
  while (renderedSize(entries, sep) > limit) {
    const demotable = findDemotableIndices(entries, skipBelow);
    if (demotable.length <= 1) break;
    if (!demoteOnePass(entries, demotable)) break;
  }

  return entries;
}

module.exports = { demoteToFit, SKIP_DEMOTION_BELOW_DEFAULT };

/**
 * workflows/work/lib/question-batching.js (GH-543)
 *
 * Single source of truth for the AskUserQuestion batch cap. The harness
 * hard-rejects AskUserQuestion payloads with more than 4 questions
 * (InputValidationError), so every question-gate delivery site slices the
 * pending set through `takeBatch()` before building an instruction.
 *
 * Deterministic by design: input order is preserved and the batch is always
 * the FRONT slice of the pending set. Because brief.md is the store of
 * record (answers persist per batch), a daemon restart re-derives the
 * identical next batch — the loop resumes instead of restarting.
 *
 * `batchNumber`/`totalBatches` are STATELESS, remaining-set-relative values:
 * each planner pass sees only what is still unresolved, so 9 pending
 * questions render 1/3 → 1/2 → 1/1 across passes (never 2/3 or 3/3).
 *
 * No env override for the cap: the harness limit is not plugin-configurable,
 * and a knob would let config drift re-trigger the exact loop this fixes.
 */

'use strict';

/** Hard cap mirroring AskUserQuestion's maximum questions per call. */
const MAX_PER_ASK = 4;

/**
 * Slice the next deliverable batch from the front of `questions`.
 *
 * @param {Array<object>} questions — pending questions in deterministic order
 * @param {number} [max=MAX_PER_ASK] — batch size ceiling (callers other than
 *   tests should not pass this; the cap is fixed by design)
 * @returns {{ batch: Array<object>, batchNumber: number, totalBatches: number,
 *             total: number, remaining: number }}
 *   `total` counts the questions passed in (the remaining set), `remaining`
 *   what is left AFTER this batch. `batchNumber` is always 1 relative to the
 *   remaining set; `totalBatches` is how many passes the remaining set still
 *   needs (stateless per-pass values — see module doc).
 */
function takeBatch(questions, max = MAX_PER_ASK) {
  const list = Array.isArray(questions) ? questions : [];
  const cap = Number.isInteger(max) && max > 0 ? max : MAX_PER_ASK;
  const batch = list.slice(0, cap);
  const total = list.length;
  return {
    batch,
    total,
    remaining: total - batch.length,
    batchNumber: 1,
    totalBatches: Math.max(1, Math.ceil(total / cap)),
  };
}

module.exports = { MAX_PER_ASK, takeBatch };

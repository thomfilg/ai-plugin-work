/**
 * Step: brief-gate (GH-215)
 *
 * Gates the `brief → spec` transition on unresolved cross-ticket or
 * architectural open questions in `brief.md`. Mirrors the sibling step
 * contract `(add, s, ctx) => void` from `./brief.js` and `./spec.js`, and
 * reuses the pure parser/rewriter in `../lib/open-questions.js`.
 *
 * Decision matrix:
 *   1. `WORK_BRIEF_ENABLED=0`                  → DEFER "Brief disabled"
 *   2. `!s.hasBrief`                           → DEFER "No brief.md present"
 *   3. `brief.md` unreadable (fail-closed)      → RUN   "brief.md unreadable — regenerate brief"
 *   4. Parser returns zero blocking questions  → DEFER "All blocking questions resolved"
 *   5. Otherwise                               → RUN with an AskUserQuestion
 *                                                payload + `onResolve: 'rewrite brief.md'`
 *
 * The RUN payload instructs the orchestrator to invoke AskUserQuestion
 * inline (hooks are non-interactive — the gate step is a planning-time
 * declaration, not a runtime prompt). Once the orchestrator has collected
 * answers, it calls the exported `applyBriefResolutions(briefPath, resolutions)`
 * post-resolve handler, which delegates to `openQuestions.applyResolutions`
 * and writes the result back to `brief.md`. Cancellations (undefined/empty
 * resolutions) are no-ops so the next planner pass re-prompts.
 */

'use strict';

const fs = require('fs');
const openQuestions = require('../lib/open-questions');

/**
 * Build the `AskUserQuestion` payload for the RUN action. Kept local so the
 * public surface of this module is just the step function and the
 * post-resolve handler.
 *
 * @param {Array<{questionText: string, rationale: string, scope: string}>} blocking
 * @returns {{questions: Array<object>}}
 */
function buildAskUserQuestionPayload(blocking) {
  return {
    questions: blocking.map((q) => ({
      questionText: q.questionText,
      scope: q.scope,
      rationale: q.rationale,
      // Orchestrator-facing hint: the answer must be persisted back into
      // the brief.md block identified by `questionText`.
      persistTo: 'brief.md',
    })),
  };
}

/**
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
function briefGateStep(add, s, ctx) {
  const { STEPS, tasksDir, path } = ctx;
  const briefEnabled = process.env.WORK_BRIEF_ENABLED !== '0';

  if (!briefEnabled) {
    add(STEPS.brief_gate, 'DEFER', null, 'Brief disabled (WORK_BRIEF_ENABLED=0)');
    return;
  }

  if (!s || !s.hasBrief) {
    add(STEPS.brief_gate, 'DEFER', null, 'No brief.md present');
    return;
  }

  const briefPath = path.join(tasksDir, 'brief.md');
  let markdown;
  try {
    markdown = fs.readFileSync(briefPath, 'utf8');
  } catch (_e) {
    // Emit RUN so the planner shows the gate needs attention — verify
    // returns false on read errors (fail-closed), so emitting DEFER here
    // would create a confusing mismatch ("gate deferred" yet transition
    // blocked). RUN with a helpful message signals the issue clearly.
    add(STEPS.brief_gate, 'RUN', '/brief', 'brief.md unreadable — regenerate brief before proceeding', {
      agentType: 'skill',
      agentPrompt: '/brief',
    });
    return; // fail-closed: verify() also returns false on read errors — aligned
  }

  const questions = openQuestions.parse(markdown);
  const blocking = openQuestions.findBlocking(questions);

  if (blocking.length === 0) {
    add(STEPS.brief_gate, 'DEFER', null, 'All blocking questions resolved');
    return;
  }

  add(
    STEPS.brief_gate,
    'RUN',
    'AskUserQuestion',
    `Resolve ${blocking.length} unresolved cross-ticket/architectural question(s)`,
    {
      agentType: 'general-purpose',
      agentPrompt: `Use AskUserQuestion to resolve ${blocking.length} unresolved open question(s) in brief.md, then call applyBriefResolutions() to persist the answers.`,
      askUserQuestionPayload: buildAskUserQuestionPayload(blocking),
      onResolve: 'rewrite brief.md',
    }
  );
}

/**
 * Post-resolve handler — invoked by the orchestrator after AskUserQuestion
 * returns. Rewrites `brief.md` in place with the user-supplied resolutions,
 * delegating all parsing/idempotency/injection-escape invariants to
 * `openQuestions.applyResolutions`.
 *
 * Cancellation path: if the caller passes `undefined`, `null`, or an empty
 * map/object, the handler is a no-op — brief.md is unchanged and the next
 * planner pass will re-prompt for the same questions.
 *
 * @param {string} briefPath
 * @param {Map<string,string>|Record<string,string>|null|undefined} resolutions
 * @returns {boolean} true if brief.md was rewritten, false if skipped.
 */
function applyBriefResolutions(briefPath, resolutions) {
  if (resolutions === undefined || resolutions === null) return false;
  // Defensive type guard: reject stray primitives (number, string, boolean,
  // symbol, bigint) before doing any I/O. Only Map or plain-object payloads
  // can carry resolution data; anything else is a caller bug and must be a
  // silent no-op — the next planner pass will re-prompt.
  if (typeof resolutions !== 'object') return false;
  if (resolutions instanceof Map && resolutions.size === 0) return false;
  if (
    !(resolutions instanceof Map) &&
    typeof resolutions === 'object' &&
    Object.keys(resolutions).length === 0
  ) {
    return false;
  }

  let markdown;
  try {
    markdown = fs.readFileSync(briefPath, 'utf8');
  } catch (_e) {
    return false;
  }

  const rewritten = openQuestions.applyResolutions(markdown, resolutions);
  if (rewritten === markdown) return false;

  try {
    fs.writeFileSync(briefPath, rewritten, 'utf8');
  } catch (_e) {
    // Fail-closed: mirror the read-failure contract so EACCES/ENOSPC/etc
    // never propagate as an uncaught exception to the orchestrator.
    return false;
  }
  return true;
}

module.exports = briefGateStep;
module.exports.briefGateStep = briefGateStep;
module.exports.applyBriefResolutions = applyBriefResolutions;

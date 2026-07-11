/**
 * Step: brief-gate (GH-215)
 *
 * Gates the `brief → spec` transition on unresolved cross-ticket or
 * architectural open questions in `brief.md`. Mirrors the sibling step
 * contract `(add, s, ctx) => void` from `./brief.js` and `./spec.js`, and
 * reuses the pure parser/rewriter in `../lib/open-questions.js`.
 *
 * Decision matrix:
 *   1. `!s.hasBrief`                           → DEFER "No brief.md present"
 *   2. `brief.md` unreadable (fail-closed)      → RUN   "brief.md unreadable — regenerate brief"
 *   3. Parser returns zero blocking questions  → DEFER "All blocking questions resolved"
 *   4. Otherwise                               → RUN with an AskUserQuestion
 *                                                payload + `onResolve: 'rewrite brief.md'`
 *
 * The RUN payload instructs the orchestrator to invoke AskUserQuestion
 * inline (hooks are non-interactive — the gate step is a planning-time
 * declaration, not a runtime prompt). Once the orchestrator has collected
 * answers, it writes them to the answers file and runs `postResolveCommand`
 * (the apply-brief-gate-answers.js CLI — GH-543 file transport, so answer
 * content never rides a shell command line). The exported
 * `applyBriefResolutions(briefPath, resolutions)` handler is kept as a thin
 * wrapper delegating to `applyGateResolutions` (kind-routing persistence +
 * brief_gate step guard). Cancellations (undefined/empty resolutions) are
 * no-ops so the next planner pass re-prompts.
 */

'use strict';

const fs = require('fs');
const openQuestions = require('../lib/open-questions');
const { applyGateResolutions } = require('../lib/apply-gate-resolutions');
const { T, renderQuestionText, getRuntime } = require('../../lib/instruction-vocab');

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
      // Envelope routing key (GH-543): the driver files the answer under
      // `openQuestions[applyKey]` in the answers-file envelope.
      kind: 'open-question',
      applyKey: q.questionText,
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
    add(
      STEPS.brief_gate,
      'RUN',
      '/brief',
      'brief.md unreadable — regenerate brief before proceeding',
      {
        agentType: 'skill',
        agentPrompt: '/brief',
      }
    );
    return; // fail-closed: verify() also returns false on read errors — aligned
  }

  const questions = openQuestions.parse(markdown);
  const blocking = openQuestions.findBlocking(questions);

  if (blocking.length === 0) {
    add(STEPS.brief_gate, 'DEFER', null, 'All blocking questions resolved');
    return;
  }

  // The question renderer keeps claude byte-identical and swaps the codex
  // vocabulary (request_user_input prose / parked-gate notice per mode, C3).
  const rt = getRuntime();
  add(
    STEPS.brief_gate,
    'RUN',
    T('tool.question', {}, rt.name),
    `Resolve ${blocking.length} unresolved cross-ticket/architectural question(s)`,
    {
      agentType: 'general-purpose',
      agentPrompt: renderQuestionText(
        `Use AskUserQuestion to resolve ${blocking.length} unresolved open question(s) in brief.md, then call applyBriefResolutions() to persist the answers.`,
        rt
      ),
      askUserQuestionPayload: buildAskUserQuestionPayload(blocking),
      onResolve: 'rewrite brief.md',
      // GH-543 file transport: the CLI reads the default answers file
      // (<tasksDir>/.brief-gate-answers.json) — no answer JSON on the argv.
      postResolveCommand: `node "${path.join(__dirname, '..', 'scripts', 'apply-brief-gate-answers.js')}" "${briefPath}"`,
    }
  );
}

/**
 * Defensive type guard for the resolutions payload: reject `undefined`/`null`,
 * stray primitives (number, string, boolean, symbol, bigint), and empty
 * containers before doing any I/O. Only a non-empty Map or plain-object
 * payload can carry resolution data; anything else is a caller bug (or a
 * cancellation) and must be a silent no-op — the next planner pass will
 * re-prompt.
 *
 * @param {Map<string,string>|Record<string,string>|null|undefined} resolutions
 * @returns {boolean} true if the payload carries at least one resolution.
 */
function hasResolutionData(resolutions) {
  if (resolutions === undefined || resolutions === null) return false;
  if (typeof resolutions !== 'object') return false;
  const size = resolutions instanceof Map ? resolutions.size : Object.keys(resolutions).length;
  return size > 0;
}

/**
 * Post-resolve handler — invoked by the orchestrator after AskUserQuestion
 * returns. Thin wrapper (GH-543): delegates to `applyGateResolutions`,
 * which coerces the flat questionText→answer map to an `{ openQuestions }`
 * envelope, keeps all parsing/idempotency/injection-escape invariants, and
 * adds the brief_gate step guard — when `.work-state.json` exists next to
 * brief.md and a step other than brief_gate is positively in_progress, the
 * write is refused (returns false).
 *
 * Cancellation path: if the caller passes `undefined`, `null`, or an empty
 * map/object, the handler is a no-op — brief.md is unchanged and the next
 * planner pass will re-prompt for the same questions.
 *
 * @param {string} briefPath
 * @param {Map<string,string>|Record<string,string>|null|undefined} resolutions
 * @returns {boolean} true if brief.md was rewritten, false if skipped/refused.
 */
function applyBriefResolutions(briefPath, resolutions) {
  if (!hasResolutionData(resolutions)) return false;
  return applyGateResolutions(briefPath, resolutions).changed === true;
}

module.exports = briefGateStep;
module.exports.briefGateStep = briefGateStep;
module.exports.applyBriefResolutions = applyBriefResolutions;

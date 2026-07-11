/**
 * Question-router enrichment for brief_gate (GH-543).
 *
 * Owns question DELIVERY: the routing block extracted from ./brief-gate.js
 * (which keeps Gate 0 manifest validation and the sibling-gap injector).
 * It splits the merged `askUserQuestionPayload` into local vs user scope;
 * local-only sets auto-pass with an informational note, user-scoped sets
 * become a blocked instruction the driver must resolve via AskUserQuestion.
 *
 * Batching: AskUserQuestion hard-caps at 4 questions per call
 * (InputValidationError above that), so the override carries AT MOST 4
 * questions — the front slice of the pending set via `takeBatch()` — plus
 * `questionProgress` metadata. The driver asks ONE batch, persists it
 * through the answers-file CLI, and re-runs work-next.js; brief.md itself
 * records resolutions, so the next planner pass statelessly re-derives the
 * next batch (a crash or daemon restart resumes instead of restarting).
 *
 * Registration order (see ./index.js): after the brief-gate injector and
 * BEFORE discrepancy-gate — the position routing was extracted from.
 * brief_gate discrepancy delivery stays opportunistic: when discrepancy
 * questions do ride along in the payload they are batched under the same
 * cap, but surfacing them at every gate is follow-up work (GH-543 design,
 * open question 2).
 */

'use strict';

const { takeBatch, MAX_PER_ASK } = require('../question-batching');

/**
 * Blocked instruction for cross-ticket/user questions (GH-543 file
 * transport + batching): answers travel via a consume-once JSON envelope
 * file, and `userQuestions` carries at most MAX_PER_ASK questions.
 */
function buildUserQuestionsBlocker(userQs, localQs, briefPath, ctx) {
  const { tasksDir, workDir, path: pathMod } = ctx;
  const answersPath = pathMod.join(tasksDir, '.brief-gate-answers.json');
  const applyCliPath = pathMod.join(workDir, 'scripts', 'apply-brief-gate-answers.js');
  const { batch, batchNumber, totalBatches, total, remaining } = takeBatch(userQs);
  return {
    type: 'work_instruction',
    action: 'blocked',
    reason: 'brief_gate requires user input for cross-ticket questions',
    userQuestions: batch.map((q, i) => ({
      // Global index within the pending set — batches are front slices, so
      // the batch-local position IS the global position.
      index: i + 1,
      question: q.questionText,
      rationale: q.rationale || '',
      scope: q.scope,
      // Envelope routing keys (GH-543). Questions from producers that
      // predate tagging default to the open-question lane.
      kind: q.kind || 'open-question',
      applyKey: q.applyKey || q.questionText,
      ...(Array.isArray(q.options) ? { options: q.options } : {}),
    })),
    // Stateless, remaining-set-relative progress: brief.md records the
    // resolutions, so each pass re-derives progress over what is still
    // unanswered (9 pending renders 1/3 → 1/2 → 1/1 across passes).
    questionProgress: {
      total,
      thisBatch: batch.length,
      remaining,
      batchNumber,
      totalBatches,
    },
    localQuestions: localQs.map((q) => q.questionText),
    applyCommand: `node "${applyCliPath}" "${briefPath}"`,
    hint:
      `(0) If ${answersPath} already exists (crash recovery), run the applyCommand first ` +
      `and re-run work-next.js. ` +
      `(1) Ask THESE questions via ONE AskUserQuestion call (never more than ${MAX_PER_ASK}). ` +
      `(2) Write the answers to ${answersPath} as a JSON envelope routed by each question's ` +
      `kind: {"openQuestions": {"<applyKey>": "<answer>", ...}, ` +
      `"siblingGaps": [{"surface": "<applyKey>", "decision": "implement-here|wait-for-sibling"}, ...], ` +
      `"discrepancies": [{"claim": "<applyKey>", "decision": "<answer>"}, ...]}. ` +
      `(3) Run the applyCommand (it persists every kind into brief.md and consumes the ` +
      `answers file on full apply). ` +
      `(4) Re-run work-next.js — it presents the next batch until none remain.`,
  };
}

module.exports = function registerQuestionRouter(register) {
  register('brief_gate', (entry, ctx) => {
    // Defer to whichever blocker already won — Gate 0 manifest failure, etc.
    if (entry._overrideInstruction) return;
    if (!entry.askUserQuestionPayload) return;

    const { tasksDir, workDir, path } = ctx;
    const questions = entry.askUserQuestionPayload.questions || [];
    if (questions.length === 0) return;

    const localQs = questions.filter((q) => q.scope === 'local');
    const userQs = questions.filter((q) => q.scope !== 'local');
    const briefGatePath = path.join(workDir, 'steps', 'brief-gate.js');
    const briefPath = path.join(tasksDir, 'brief.md');

    // Only local questions — non-blocking, resolved during spec phase
    if (userQs.length === 0) {
      const lines = ['## brief_gate: Local Questions (non-blocking)\n'];
      lines.push(
        'These questions will be answered by the spec-writer when it analyzes the codebase.'
      );
      lines.push('No action needed — the gate passes automatically.\n');
      localQs.forEach((q, i) => {
        lines.push(`${i + 1}. "${q.questionText}" → deferred to spec`);
      });
      entry.agentPrompt = lines.join('\n');
      return;
    }

    // Cross-ticket/user questions — MUST ask the user, not delegate to agent
    // Override the delegate type to force a blocked instruction
    entry.agentType = 'Bash';
    entry.agentPrompt = 'echo "brief_gate: waiting for user answers"';

    // Store the questions and paths for the orchestrator to use
    entry._briefGateUserQuestions = userQs;
    entry._briefGateLocalQuestions = localQs;
    entry._briefGatePath = briefGatePath;
    entry._briefPath = briefPath;

    // Return a blocked instruction instead — the orchestrator must ask the user
    entry._overrideInstruction = buildUserQuestionsBlocker(userQs, localQs, briefPath, ctx);
  });
};

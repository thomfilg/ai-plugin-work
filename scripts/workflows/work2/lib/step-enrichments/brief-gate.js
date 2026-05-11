/**
 * Brief-gate step enrichment.
 *
 * When there are cross-ticket/user questions → returns a blocked instruction
 * that forces the orchestrator to stop and ask the user directly.
 * The agent CANNOT answer cross-ticket questions on its own.
 *
 * When there are only local questions → auto-passes (resolved during spec).
 */

'use strict';

module.exports = function registerBriefGate(register) {
  register('brief_gate', (entry, ctx) => {
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
      lines.push('These questions will be answered by the spec-writer when it analyzes the codebase.');
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
    entry._overrideInstruction = {
      type: 'work_instruction',
      action: 'blocked',
      reason: 'brief_gate requires user input for cross-ticket questions',
      userQuestions: userQs.map((q, i) => ({
        index: i + 1,
        question: q.questionText,
        rationale: q.rationale || '',
        scope: q.scope,
      })),
      localQuestions: localQs.map((q) => q.questionText),
      applyCommand: `node -e "require('${briefGatePath}').applyBriefResolutions('${briefPath}', JSON.parse(process.argv[1]))" '<JSON_MAP>'`,
      hint: 'Answer the userQuestions, then run the applyCommand with a JSON map of questionText → answer. Re-run work-next.js after.',
    };
  });
};

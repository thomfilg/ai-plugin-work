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

const fsMod = require('fs');
const relatedTickets = require('../../../lib/related-tickets');
const tp = require('../../../lib/ticket-provider');
const {
  findUnresolvedSiblingGaps,
  buildSiblingGapQuestions,
} = require('../../../lib/brief-sibling-gaps');

function _readBriefText(tasksDir, pathMod) {
  try {
    return fsMod.readFileSync(pathMod.join(tasksDir, 'brief.md'), 'utf8');
  } catch {
    return null;
  }
}

function _injectSiblingGapQuestions(entry, ctx) {
  const { tasksDir, ticket, path: pathMod } = ctx;
  const briefText = _readBriefText(tasksDir, pathMod);
  if (!briefText) return;
  const { unresolved } = findUnresolvedSiblingGaps(briefText);
  if (unresolved.length === 0) return;
  const newQs = buildSiblingGapQuestions(unresolved, ticket);
  const existing = entry.askUserQuestionPayload || { questions: [] };
  const merged = (existing.questions || []).slice();
  for (const q of newQs) merged.push(q);
  entry.askUserQuestionPayload = { ...existing, questions: merged };
}

function buildRelatedTicketsBlocker(ticket, tasksDir, pathMod, fs, providerConfig) {
  const result = relatedTickets.readAndValidate(tasksDir, { fs, path: pathMod });
  if (result.valid) return null;
  const manifestFile = relatedTickets.manifestPath(tasksDir, pathMod);
  const reasonParts = [];
  if (result.missing) reasonParts.push('related-tickets.json is missing');
  else reasonParts.push('related-tickets.json failed schema validation');
  if (result.errors.length) reasonParts.push('errors: ' + result.errors.join('; '));
  const fetchPrompt =
    providerConfig && tp.getRelatedTicketsPrompt(ticket, providerConfig, manifestFile);
  return {
    type: 'work_instruction',
    action: 'blocked',
    reason: 'brief_gate: ' + reasonParts.join('. '),
    manifestPath: manifestFile,
    expectedSchema: 'see scripts/workflows/lib/related-tickets.js (validate())',
    hint:
      'The brief-writer must fetch related tickets and write a valid manifest before brief_gate can pass. ' +
      'Re-run the brief step, ensure the agent writes ' +
      manifestFile +
      ', then re-run /work.',
    fetchPrompt: fetchPrompt || '(provider not configured — manual fetch required)',
  };
}

/**
 * Blocked instruction for cross-ticket/user questions (GH-543 file
 * transport): answers travel via a consume-once JSON envelope file, so
 * quotes/backticks/newlines in an answer can never break (or execute on) a
 * shell command line the way the old inline '<JSON_MAP>' argv did.
 */
function buildUserQuestionsBlocker(userQs, localQs, briefPath, ctx) {
  const { tasksDir, workDir, path: pathMod } = ctx;
  const answersPath = pathMod.join(tasksDir, '.brief-gate-answers.json');
  const applyCliPath = pathMod.join(workDir, 'scripts', 'apply-brief-gate-answers.js');
  return {
    type: 'work_instruction',
    action: 'blocked',
    reason: 'brief_gate requires user input for cross-ticket questions',
    userQuestions: userQs.map((q, i) => ({
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
    localQuestions: localQs.map((q) => q.questionText),
    applyCommand: `node "${applyCliPath}" "${briefPath}"`,
    hint:
      `Ask the userQuestions, then Write the answers to ${answersPath} as a JSON envelope ` +
      `routed by each question's kind: {"openQuestions": {"<applyKey>": "<answer>", ...}, ` +
      `"siblingGaps": [{"surface": "<applyKey>", "decision": "implement-here|wait-for-sibling"}, ...], ` +
      `"discrepancies": [{"claim": "<applyKey>", "decision": "<answer>"}, ...]}. ` +
      'Then run the applyCommand (it persists every kind into brief.md and consumes the ' +
      'answers file on full apply) and re-run work-next.js after.',
  };
}

module.exports = function registerBriefGate(register) {
  register('brief_gate', (entry, ctx) => {
    const { tasksDir, ticket, workDir, path, fs } = ctx;

    // Validate the related-tickets manifest before any other brief_gate logic.
    // A missing/invalid manifest blocks transition regardless of pending questions.
    let providerConfig = null;
    try {
      providerConfig = tp.getProviderConfig({ cwd: workDir, skipPrompt: true });
    } catch {
      /* fail-open */
    }
    // Only enforce when a provider is configured. With 'none', skip the gate.
    if (providerConfig && providerConfig.provider !== 'none') {
      const blocker = buildRelatedTicketsBlocker(ticket, tasksDir, path, fs, providerConfig);
      if (blocker) {
        entry.agentType = 'Bash';
        entry.agentPrompt = 'echo "brief_gate: related-tickets.json missing or invalid"';
        entry._overrideInstruction = blocker;
        return;
      }
    }

    // Gate A — surface unresolved sibling-gap entries from the brief as
    // user-scoped questions BEFORE the open-question routing below decides
    // whether to block.
    _injectSiblingGapQuestions(entry, ctx);

    if (!entry.askUserQuestionPayload) return;

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

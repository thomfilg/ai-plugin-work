/**
 * Brief-gate step enrichment — INJECTOR ONLY (GH-543).
 *
 * Owns Gate 0 (related-tickets manifest validation) and Gate A (sibling-gap
 * question injection into `askUserQuestionPayload`). Question DELIVERY —
 * local/user routing, the blocked instruction, and batching to the
 * AskUserQuestion 4-question cap — lives in ./question-router.js, which
 * registers after this injector (see ./index.js).
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
    // user-scoped questions BEFORE the question-router (registered after
    // this injector) decides whether to block.
    _injectSiblingGapQuestions(entry, ctx);
  });
};

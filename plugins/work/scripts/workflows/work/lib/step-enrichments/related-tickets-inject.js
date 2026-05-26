/**
 * Related-tickets injection enrichment.
 *
 * At the `brief` step, instruct the brief-writer to fetch parent + siblings +
 * blockedBy + dependsOn + relatedTo via the configured ticket provider and
 * write the manifest to `tasks/<ticket>/related-tickets.json`.
 *
 * At downstream steps (`spec`, `tasks`, `implement`), inject a "READ THIS FIRST"
 * pointer to the manifest so those agents treat it as authoritative for
 * sibling-ownership facts.
 *
 * The manifest is the single source of truth for which surfaces (files/symbols)
 * belong to sibling tickets. Downstream gates (Gate A, Gate B, Gate C, Gate D)
 * use it to block scope creep.
 */

'use strict';

const tp = require('../../../lib/ticket-provider');
const relatedTickets = require('../../../lib/related-tickets');

const FETCH_STEP = 'brief';
const READ_STEPS = ['brief', 'spec', 'tasks', 'implement'];

function buildFetchBlock(tpRef, ticket, providerConfig, manifestPath) {
  const prompt = tpRef.getRelatedTicketsPrompt(ticket, providerConfig, manifestPath);
  if (!prompt) return null;
  return (
    '\n\n## Related Tickets Manifest (REQUIRED — fetch FIRST)\n' +
    'Before drafting the brief, you MUST fetch related tickets and write the manifest.\n' +
    'Downstream agents (spec-writer, jira-task-creator) read this file to decide which surfaces are owned by sibling tickets.\n' +
    'A missing or invalid manifest blocks brief_gate.\n\n' +
    prompt
  );
}

function buildReadBlock(manifestPath) {
  return (
    '\n\n## Related Tickets (READ FIRST)\n' +
    '- **Manifest:** ' +
    manifestPath +
    '\n' +
    'Read this file in full BEFORE doing any work. It documents:\n' +
    '- The parent ticket and its surfaces.\n' +
    '- Sibling tickets (children of the same parent) and the files they own.\n' +
    '- `blockedBy` / `dependsOn` / `relatedTo` links and the files they own.\n' +
    "Treat any file listed under a sibling's `surfaces` as **out-of-scope** for the current ticket.\n" +
    'If your work requires touching a sibling-owned surface, STOP and surface the gap as a question — do NOT absorb it into the current ticket.'
  );
}

module.exports = function registerRelatedTicketsInject(register) {
  // Brief_gate validation lives in brief-gate.js — this enrichment only
  // handles prompt injection for the brief step + READ-FIRST pointers for
  // downstream steps. Keeping the gate logic and the prompt logic in
  // separate files mirrors the rest of the step-enrichment layout.

  register(FETCH_STEP, (entry, ctx) => {
    const { tasksDir, ticket, path: pathMod } = ctx;
    let providerConfig = null;
    try {
      providerConfig = (ctx.tp || tp).getProviderConfig({ cwd: ctx.workDir, skipPrompt: true });
    } catch {
      /* fail-open */
    }
    if (!providerConfig) return;
    const manifestFile = relatedTickets.manifestPath(tasksDir, pathMod);
    const block = buildFetchBlock(ctx.tp || tp, ticket, providerConfig, manifestFile);
    if (!block) return;
    entry.agentPrompt = (entry.agentPrompt || '') + block;
  });

  for (const stepName of READ_STEPS) {
    register(stepName, (entry, ctx) => {
      const { tasksDir, path: pathMod, fs } = ctx;
      const manifestFile = relatedTickets.manifestPath(tasksDir, pathMod);
      // Only inject the READ block when the manifest exists — at the brief
      // step the agent hasn't written it yet, so the fetch block (above)
      // handles that case.
      if (!fs.existsSync(manifestFile)) return;
      entry.agentPrompt = (entry.agentPrompt || '') + buildReadBlock(manifestFile);
    });
  }
};
